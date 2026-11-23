//! Node sidecar 进程：启动、按行收发 JSON 消息、转发界面请求。消息格式见 `src/sidecar/protocol.ts`。

use crate::storage::StorageDirectories;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{self, Write};
use std::process::{ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};
use tokio::sync::oneshot;

/// 发布版里 sidecar 可执行文件的名字，和主程序放在同一文件夹。
#[cfg(not(debug_assertions))]
const SIDECAR_FILE_NAME: &str = if cfg!(windows) {
    "savedata-sync-backend.exe"
} else {
    "savedata-sync-backend"
};

/// 界面主题偏好。
#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ThemePreference {
    System,
    Light,
    Dark,
}

/// 浅色和深色主题下窗口的背景色，格式 `#rrggbb`。
#[derive(Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct BackgroundColors {
    pub light: String,
    pub dark: String,
}

/// sidecar 请求宿主做的事。
#[derive(Deserialize, Debug, PartialEq, Eq)]
#[serde(tag = "method", content = "params", rename_all = "camelCase")]
pub enum HostRequest {
    /// 打开目录选择器；应答选中的绝对路径，取消时应答 null。
    ChooseDirectory { title: String },
    /// 打开只列出 JPEG、PNG、WebP 和 GIF 的文件选择器；应答选中文件的绝对路径，取消时应答 null。
    ChooseImageFile { title: String },
    /// 用系统文件管理器打开路径。
    OpenPath { path: String },
    /// 设置窗口和界面的明暗。
    SetTheme { theme: ThemePreference },
}

/// sidecar 发给宿主的消息。
#[derive(Deserialize, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum SidecarMessage {
    /// 后端初始化完成，可以打开窗口。
    #[serde(rename_all = "camelCase")]
    Ready {
        title: String,
        background_colors: BackgroundColors,
        stopped_title: String,
        stopped_message: String,
    },
    /// 后端初始化失败，sidecar 随后退出。
    Fatal { title: String, message: String },
    /// 界面请求的结果。通道处理函数返回 undefined 时 JSON 里没有 value，按 null 处理。
    #[serde(rename = "result")]
    InvokeResult {
        id: u64,
        #[serde(default)]
        value: Value,
    },
    /// 停止请求的结果；is_stopped 为 false 时 title 和 message 是要显示的失败提示。
    #[serde(rename_all = "camelCase")]
    ShutdownResult {
        id: u64,
        is_stopped: bool,
        title: Option<String>,
        message: Option<String>,
    },
    /// sidecar 请求宿主提供的平台能力，宿主用 [`Sidecar::respond`] 应答。
    HostRequest {
        id: u64,
        #[serde(flatten)]
        request: HostRequest,
    },
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // 持锁的代码只做插入、取出和写管道，不会留下不一致的状态，锁中毒后照常使用。
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// 运行中的 sidecar 进程。释放后 sidecar 的 stdin 关闭，sidecar 停止服务后自行退出。
pub struct Sidecar {
    stdin: Mutex<ChildStdin>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    next_id: AtomicU64,
}

impl Sidecar {
    /// 启动 sidecar，把存储目录和系统语言作为命令行参数传入。
    ///
    /// 调试版用 PATH 里的 `node` 运行 `out/sidecar/index.cjs`，发布版运行主程序旁边的 sidecar 可执行文件。
    /// sidecar 的 stderr 继承宿主的 stderr。
    ///
    /// # Errors
    ///
    /// 找不到或无法启动 sidecar 时返回 I/O 错误。
    pub fn spawn(
        directories: &StorageDirectories,
        languages: &str,
    ) -> io::Result<(Self, ChildStdout)> {
        let mut command = Self::command()?;
        command
            .arg("--config-dir")
            .arg(&directories.config)
            .arg("--data-dir")
            .arg(&directories.data)
            .arg("--backup-dir")
            .arg(&directories.backups)
            .arg("--cache-dir")
            .arg(&directories.cache)
            .arg("--languages")
            .arg(languages)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // 发布版主程序没有控制台，不加这个标志时 sidecar 会弹出一个控制台窗口。
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command.spawn()?;
        let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
            return Err(io::Error::other("The sidecar pipes are unavailable."));
        };
        let sidecar = Self {
            stdin: Mutex::new(stdin),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(0),
        };
        Ok((sidecar, stdout))
    }

    #[cfg(debug_assertions)]
    fn command() -> io::Result<Command> {
        let mut command = Command::new("node");
        command.arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../out/sidecar/index.cjs"
        ));
        Ok(command)
    }

    #[cfg(not(debug_assertions))]
    fn command() -> io::Result<Command> {
        let executable = std::env::current_exe()?;
        let directory = executable
            .parent()
            .ok_or_else(|| io::Error::other("The executable has no parent directory."))?;
        Ok(Command::new(directory.join(SIDECAR_FILE_NAME)))
    }

    fn send(&self, message: &Value) -> io::Result<()> {
        let mut line = message.to_string();
        line.push('\n');
        let mut stdin = lock(&self.stdin);
        stdin.write_all(line.as_bytes())?;
        stdin.flush()
    }

    /// 把界面请求转给 sidecar，等待结果。
    ///
    /// # Errors
    ///
    /// sidecar 已经退出或在应答前退出时返回错误说明。
    pub async fn invoke(&self, channel: String, args: Vec<Value>) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        lock(&self.pending).insert(id, sender);
        if let Err(error) =
            self.send(&json!({ "type": "invoke", "id": id, "channel": channel, "args": args }))
        {
            lock(&self.pending).remove(&id);
            return Err(format!("The desktop service is unavailable: {error}"));
        }
        receiver
            .await
            .map_err(|_| "The desktop service stopped before responding.".to_owned())
    }

    /// 交付 id 对应的界面请求结果；没有等待中的请求时忽略。
    pub fn resolve(&self, id: u64, value: Value) {
        if let Some(sender) = lock(&self.pending).remove(&id) {
            // 发起请求的界面调用可能已经取消，结果没人接收时直接丢弃。
            let _ = sender.send(value);
        }
    }

    /// 让所有等待中的界面请求失败，它们的 [`Sidecar::invoke`] 返回错误。
    pub fn fail_pending(&self) {
        lock(&self.pending).clear();
    }

    /// 应答 sidecar 的 host-request；error 是失败原因。
    ///
    /// # Errors
    ///
    /// sidecar 的 stdin 已经关闭时返回 I/O 错误。
    pub fn respond(&self, id: u64, result: Result<Value, String>) -> io::Result<()> {
        match result {
            Ok(value) => self.send(&json!({ "type": "host-result", "id": id, "value": value })),
            Err(error) => self.send(&json!({ "type": "host-result", "id": id, "error": error })),
        }
    }

    /// 请求 sidecar 停止全部服务；结果以 [`SidecarMessage::ShutdownResult`] 返回。
    ///
    /// # Errors
    ///
    /// sidecar 的 stdin 已经关闭时返回 I/O 错误。
    pub fn shutdown(&self) -> io::Result<()> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.send(&json!({ "type": "shutdown", "id": id }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ready_message() {
        let message: SidecarMessage = serde_json::from_str(
            r##"{"type":"ready","title":"存档同步","backgroundColors":{"light":"#ffffff","dark":"#000000"},"stoppedTitle":"t","stoppedMessage":"m"}"##,
        )
        .unwrap();
        assert_eq!(
            message,
            SidecarMessage::Ready {
                title: "存档同步".to_owned(),
                background_colors: BackgroundColors {
                    light: "#ffffff".to_owned(),
                    dark: "#000000".to_owned(),
                },
                stopped_title: "t".to_owned(),
                stopped_message: "m".to_owned(),
            }
        );
    }

    #[test]
    fn parses_result_without_value_as_null() {
        let message: SidecarMessage = serde_json::from_str(r#"{"type":"result","id":3}"#).unwrap();
        assert_eq!(
            message,
            SidecarMessage::InvokeResult {
                id: 3,
                value: Value::Null
            }
        );
    }

    #[test]
    fn parses_shutdown_result() {
        let message: SidecarMessage =
            serde_json::from_str(r#"{"type":"shutdown-result","id":1,"isStopped":true}"#).unwrap();
        assert_eq!(
            message,
            SidecarMessage::ShutdownResult {
                id: 1,
                is_stopped: true,
                title: None,
                message: None
            }
        );
    }

    #[test]
    fn parses_host_requests() {
        let cases = [
            (
                r#"{"type":"host-request","id":0,"method":"chooseDirectory","params":{"title":"选择"}}"#,
                HostRequest::ChooseDirectory {
                    title: "选择".to_owned(),
                },
            ),
            (
                r#"{"type":"host-request","id":0,"method":"chooseImageFile","params":{"title":"图片"}}"#,
                HostRequest::ChooseImageFile {
                    title: "图片".to_owned(),
                },
            ),
            (
                r#"{"type":"host-request","id":0,"method":"openPath","params":{"path":"C:\\a"}}"#,
                HostRequest::OpenPath {
                    path: "C:\\a".to_owned(),
                },
            ),
            (
                r#"{"type":"host-request","id":0,"method":"setTheme","params":{"theme":"dark"}}"#,
                HostRequest::SetTheme {
                    theme: ThemePreference::Dark,
                },
            ),
        ];
        for (line, request) in cases {
            let message: SidecarMessage = serde_json::from_str(line).unwrap();
            assert_eq!(message, SidecarMessage::HostRequest { id: 0, request });
        }
    }

    #[test]
    fn rejects_unknown_messages() {
        assert!(serde_json::from_str::<SidecarMessage>(r#"{"type":"other","id":0}"#).is_err());
        assert!(serde_json::from_str::<SidecarMessage>(
            r#"{"type":"host-request","id":0,"method":"setTheme","params":{"theme":"blue"}}"#
        )
        .is_err());
    }
}
