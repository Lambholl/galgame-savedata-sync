//! 电脑端 Tauri 宿主：启动 Node sidecar，打开主窗口，把界面请求转给 sidecar，并为 sidecar 提供平台能力。

// 发布版不带控制台窗口。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod sidecar;
mod storage;

use serde_json::Value;
use sidecar::{BackgroundColors, HostRequest, Sidecar, SidecarMessage, ThemePreference};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::ChildStdout;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use tauri::window::Color;
use tauri::{
    AppHandle, Manager, Theme, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

/// 主窗口的标签；capabilities/main.json 按它授权。
const MAIN_WINDOW: &str = "main";
/// sidecar 在发出 ready 之前退出时显示的提示；这时还没有按语言翻译的文字。
const STARTUP_FAILED_TITLE: &str = "Savedata Sync";
const STARTUP_FAILED_MESSAGE: &str = "The background service could not start.";

/// 宿主各部分共用的状态。
struct HostState {
    sidecar: Sidecar,
    /// 界面要求的窗口明暗；None 表示跟随系统。窗口创建前收到的设置也存在这里。
    theme: Mutex<Option<Theme>>,
    /// ready 消息里的背景色和意外退出提示，ready 之前为 None。
    ready: Mutex<Option<ReadyText>>,
    /// 已经请求 sidecar 停止、还没收到结果。
    is_closing: AtomicBool,
    /// 宿主正在按计划退出，sidecar 随后退出不算意外。
    is_exiting: AtomicBool,
}

struct ReadyText {
    background_colors: BackgroundColors,
    stopped_title: String,
    stopped_message: String,
}

impl HostState {
    fn theme(&self) -> Option<Theme> {
        *self.theme.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// 界面唯一能调用的命令：把通道请求转给 sidecar。
#[tauri::command]
async fn backend_invoke(
    state: tauri::State<'_, Arc<HostState>>,
    channel: String,
    args: Vec<Value>,
) -> Result<Value, String> {
    state.sidecar.invoke(channel, args).await
}

/// 显示错误提示并阻塞到用户关闭；不能在主线程调用。
fn show_error(app: &AppHandle, title: &str, message: &str) {
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Error)
        .blocking_show();
}

/// 把 `#rrggbb` 转成颜色；格式不对时返回 None。
fn parse_color(value: &str) -> Option<Color> {
    let hex = value.strip_prefix('#').filter(|hex| hex.len() == 6)?;
    let channel = |index: usize| u8::from_str_radix(hex.get(index..index + 2)?, 16).ok();
    Some(Color(channel(0)?, channel(2)?, channel(4)?, 255))
}

/// 按窗口当前的实际明暗设置背景色，避免页面加载前和换主题时露出另一种底色。
fn update_background(window: &WebviewWindow, state: &HostState) {
    let ready = state.ready.lock().unwrap_or_else(PoisonError::into_inner);
    let Some(ready) = ready.as_ref() else {
        return;
    };
    let colors = &ready.background_colors;
    let value = match window.theme() {
        Ok(Theme::Dark) => &colors.dark,
        _ => &colors.light,
    };
    if let Some(color) = parse_color(value) {
        if let Err(error) = window.set_background_color(Some(color)) {
            eprintln!("Failed to set the window background: {error}");
        }
    }
}

fn create_main_window(
    app: &AppHandle,
    state: &HostState,
    title: &str,
    webview_directory: PathBuf,
) -> tauri::Result<()> {
    // 先隐藏创建，按实际明暗设好背景色后再显示。
    let window = WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App("index.html".into()))
        .title(title)
        .inner_size(1100.0, 760.0)
        .min_inner_size(720.0, 520.0)
        .theme(state.theme())
        .data_directory(webview_directory)
        .visible(false)
        .build()?;
    update_background(&window, state);
    window.show()?;
    window.set_focus()
}

fn handle_host_request(app: &AppHandle, state: &Arc<HostState>, id: u64, request: HostRequest) {
    let respond = move |state: &HostState, result: Result<Value, String>| {
        if let Err(error) = state.sidecar.respond(id, result) {
            eprintln!("Failed to answer the sidecar: {error}");
        }
    };
    match request {
        HostRequest::ChooseDirectory { title } => {
            let app = app.clone();
            let state = Arc::clone(state);
            // 选择器阻塞到用户关闭，放到单独的线程，读取线程继续处理其他消息。
            std::thread::spawn(move || {
                let mut dialog = app.dialog().file().set_title(title);
                if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                    dialog = dialog.set_parent(&window);
                }
                let result = match dialog.blocking_pick_folder() {
                    None => Ok(Value::Null),
                    Some(path) => path
                        .into_path()
                        .map_err(|error| error.to_string())
                        .and_then(|path| {
                            path.into_os_string()
                                .into_string()
                                .map(Value::String)
                                .map_err(|_| "The selected path is not valid Unicode.".to_owned())
                        }),
                };
                respond(&state, result);
            });
        }
        HostRequest::OpenPath { path } => {
            let result = app
                .opener()
                .open_path(path, None::<&str>)
                .map(|()| Value::Null)
                .map_err(|error| error.to_string());
            respond(state, result);
        }
        HostRequest::SetTheme { theme } => {
            let theme = match theme {
                ThemePreference::System => None,
                ThemePreference::Light => Some(Theme::Light),
                ThemePreference::Dark => Some(Theme::Dark),
            };
            *state.theme.lock().unwrap_or_else(PoisonError::into_inner) = theme;
            if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                if let Err(error) = window.set_theme(theme) {
                    eprintln!("Failed to set the window theme: {error}");
                }
                update_background(&window, state);
            }
            respond(state, Ok(Value::Null));
        }
    }
}

/// 逐行读取 sidecar 的消息，直到 sidecar 退出。阻塞调用线程。
fn read_messages(
    app: AppHandle,
    state: Arc<HostState>,
    stdout: ChildStdout,
    webview_directory: PathBuf,
) {
    for line in BufReader::new(stdout).lines() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                eprintln!("Failed to read from the sidecar: {error}");
                break;
            }
        };
        let message = match serde_json::from_str::<SidecarMessage>(&line) {
            Ok(message) => message,
            Err(error) => {
                eprintln!("Ignored a malformed sidecar message: {error}");
                continue;
            }
        };
        match message {
            SidecarMessage::Ready {
                title,
                background_colors,
                stopped_title,
                stopped_message,
            } => {
                *state.ready.lock().unwrap_or_else(PoisonError::into_inner) = Some(ReadyText {
                    background_colors,
                    stopped_title,
                    stopped_message,
                });
                if let Err(error) =
                    create_main_window(&app, &state, &title, webview_directory.clone())
                {
                    eprintln!("Failed to open the main window: {error}");
                    state.is_exiting.store(true, Ordering::SeqCst);
                    app.exit(1);
                    return;
                }
            }
            SidecarMessage::Fatal { title, message } => {
                state.is_exiting.store(true, Ordering::SeqCst);
                show_error(&app, &title, &message);
                app.exit(1);
                return;
            }
            SidecarMessage::InvokeResult { id, value } => state.sidecar.resolve(id, value),
            SidecarMessage::ShutdownResult {
                is_stopped,
                title,
                message,
                ..
            } => {
                if is_stopped {
                    state.is_exiting.store(true, Ordering::SeqCst);
                    app.exit(0);
                    return;
                }
                state.is_closing.store(false, Ordering::SeqCst);
                if let (Some(title), Some(message)) = (title, message) {
                    // 提示框阻塞到用户关闭，期间读取线程还要继续交付界面请求的结果。
                    let app = app.clone();
                    std::thread::spawn(move || show_error(&app, &title, &message));
                }
            }
            SidecarMessage::HostRequest { id, request } => {
                handle_host_request(&app, &state, id, request);
            }
        }
    }
    state.sidecar.fail_pending();
    if state.is_exiting.load(Ordering::SeqCst) {
        return;
    }
    let (title, message) = match state
        .ready
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .as_ref()
    {
        Some(ready) => (ready.stopped_title.clone(), ready.stopped_message.clone()),
        None => (
            STARTUP_FAILED_TITLE.to_owned(),
            STARTUP_FAILED_MESSAGE.to_owned(),
        ),
    };
    show_error(&app, &title, &message);
    app.exit(1);
}

fn start(app: &AppHandle) -> Result<(), String> {
    let directories = storage::resolve(app)?;
    let languages = sys_locale::get_locales().collect::<Vec<_>>().join(",");
    let (sidecar, stdout) = Sidecar::spawn(&directories, &languages)
        .map_err(|error| format!("Cannot start the sidecar: {error}"))?;
    let state = Arc::new(HostState {
        sidecar,
        theme: Mutex::new(None),
        ready: Mutex::new(None),
        is_closing: AtomicBool::new(false),
        is_exiting: AtomicBool::new(false),
    });
    app.manage(Arc::clone(&state));
    let app = app.clone();
    let webview_directory = directories.webview();
    std::thread::spawn(move || read_messages(app, state, stdout, webview_directory));
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                // 窗口可能最小化或在后台；聚焦失败不影响已运行的实例。
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![backend_invoke])
        .setup(|app| {
            if let Err(error) = start(app.handle()) {
                eprintln!("{error}");
                let app = app.handle().clone();
                // 阻塞的提示框不能在主线程显示。
                std::thread::spawn(move || {
                    show_error(&app, STARTUP_FAILED_TITLE, STARTUP_FAILED_MESSAGE);
                    app.exit(1);
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            let Some(state) = window.try_state::<Arc<HostState>>() else {
                return;
            };
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    // 先请求 sidecar 停止服务，收到成功的结果后再退出。
                    api.prevent_close();
                    if state.is_closing.swap(true, Ordering::SeqCst) {
                        return;
                    }
                    if let Err(error) = state.sidecar.shutdown() {
                        // stdin 已关闭说明 sidecar 已经退出，读取线程会提示并退出。
                        eprintln!("Failed to ask the sidecar to stop: {error}");
                    }
                }
                WindowEvent::ThemeChanged(_) => {
                    if let Some(window) = window.app_handle().get_webview_window(window.label()) {
                        update_background(&window, &state);
                    }
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run the Tauri application");
}
