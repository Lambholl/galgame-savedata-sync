//! 配置、数据、备份库和缓存目录的位置。

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Runtime};

/// 系统目录下本应用的文件夹名。
const APP_DIRECTORY_NAME: &str = "galgame-savedata-sync";
/// 程序所在文件夹里存在这个文件夹时进入便携模式，程序所在文件夹见 [`program_directory`]。
const PORTABLE_DIRECTORY_NAME: &str = "portable_data";

/// 宿主和 sidecar 使用的存储目录，都是绝对路径，不一定已经存在。
pub struct StorageDirectories {
    /// 界面偏好。
    pub config: PathBuf,
    /// 设备身份、目录登记、游戏库等只对本机有效的数据。
    pub data: PathBuf,
    /// 默认备份库。
    pub backups: PathBuf,
    /// 可以随时删除的缓存。
    pub cache: PathBuf,
}

impl StorageDirectories {
    fn under(root: &Path) -> Self {
        Self {
            config: root.join("config"),
            data: root.join("data"),
            backups: root.join("backups"),
            cache: root.join("cache"),
        }
    }

    /// WebView 的用户数据目录，位于缓存目录下。
    pub fn webview(&self) -> PathBuf {
        self.cache.join("webview")
    }
}

/// 用户眼里程序所在的文件夹：从 AppImage 运行时是 `.AppImage` 文件所在的文件夹，否则是主程序所在的文件夹。
///
/// # Errors
///
/// 取不到主程序路径时返回错误说明。
fn program_directory() -> Result<Option<PathBuf>, String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("Cannot locate the executable: {error}"))?;
    // AppImage 运行时把主程序挂载在临时目录（APPDIR），APPIMAGE 是 .AppImage 文件的路径。
    // 从 AppImage 启动的程序会把这两个变量传给子进程，所以要求主程序确实在 APPDIR 里。
    if cfg!(target_os = "linux") {
        if let (Some(image), Some(mount)) =
            (std::env::var_os("APPIMAGE"), std::env::var_os("APPDIR"))
        {
            if executable.starts_with(&mount) {
                return Ok(Path::new(&image).parent().map(Path::to_path_buf));
            }
        }
    }
    Ok(executable.parent().map(Path::to_path_buf))
}

/// 算出存储目录：程序所在文件夹（见 [`program_directory`]）里有 `portable_data` 时用它下面的子目录，
/// 否则用系统的用户目录。
///
/// # Errors
///
/// 取不到主程序路径或系统的用户目录时返回错误说明。
pub fn resolve<R: Runtime>(app: &AppHandle<R>) -> Result<StorageDirectories, String> {
    if let Some(portable) = program_directory()?
        .map(|directory| directory.join(PORTABLE_DIRECTORY_NAME))
        .filter(|path| path.is_dir())
    {
        return Ok(StorageDirectories::under(&portable));
    }
    let paths = app.path();
    let unavailable = |error: tauri::Error| format!("Cannot locate the user directories: {error}");
    let local = paths
        .local_data_dir()
        .map_err(unavailable)?
        .join(APP_DIRECTORY_NAME);
    // Windows 没有单独的缓存根，缓存放在 Local 下本应用文件夹的 cache 里；Linux 用 XDG 缓存目录。
    let cache = if cfg!(windows) {
        local.join("cache")
    } else {
        paths
            .cache_dir()
            .map_err(unavailable)?
            .join(APP_DIRECTORY_NAME)
    };
    Ok(StorageDirectories {
        config: paths
            .config_dir()
            .map_err(unavailable)?
            .join(APP_DIRECTORY_NAME),
        data: local.join("data"),
        backups: local.join("backups"),
        cache,
    })
}
