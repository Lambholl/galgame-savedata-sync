---
doc_type: adr
status: accepted
updated: 2026-11-26
tags: [决策, 桌面端, Tauri, sidecar, 存储目录, 便携模式, 备份库]
---

# ADR-0005 桌面端采用 Tauri 宿主和 Node sidecar，存储目录按配置、数据、备份库、缓存分开

## 目录

- [状态](#状态)
- [替代关系](#替代关系)
- [背景](#背景)
- [决策](#决策)
  - [宿主与后端](#宿主与后端)
  - [分发](#分发)
  - [存储目录](#存储目录)
  - [便携模式](#便携模式)
  - [备份库位置](#备份库位置)
- [原因](#原因)
- [影响](#影响)
  - [正面影响](#正面影响)
  - [负面影响](#负面影响)
- [替代方案](#替代方案)
- [相关文件](#相关文件)

## 状态

accepted。宿主、sidecar、存储目录、Windows 打包、数据文件读不懂时的启动处理和自定义备份库位置已实现；备份库位置的实现和验证情况见 [桌面端平台层](../architecture/desktop.md)第 12、15 节。

## 替代关系

| 被替代 ADR | 原路径 | 原因 |
| --- | --- | --- |
| 无 | 无 | 新决策；修订 [Q-001](../requirements/open-questions.md) 结论里的“Windows Electron” |

## 背景

- Electron 分发包自带 Chromium 和 Node。桌面端后端（目录读取、归档、HTTP 服务、拨号、备份、写入）是纯 Node 代码，和 Electron 的耦合只有窗口、对话框、主题、`userData` 路径和 IPC。
- Electron 的 `userData` 在 Windows 的 Roaming 目录下，设备 ID、目录登记、备份和传输缓存都放在那里，还混着 Chromium 的 `GPUCache`、`Local Storage` 等缓存。域环境下 Roaming 会同步到同一用户的其他电脑，设备 ID 会被两台电脑共用，大体积的备份也会拖慢登录。
- 以后可能支持 Linux，存储结构不应写死 Windows 路径。
- 应用还在测试阶段，存储格式和位置可以不兼容地修改，不迁移 Electron 版的数据。

## 决策

### 宿主与后端

1. 桌面端用 Tauri 2 作宿主，界面运行在系统 WebView（Windows 为 WebView2，Linux 为 WebKitGTK）里，React 界面和 bridge 接口不变。
2. 后端 `apps/desktop/src/backend` 作为 Node sidecar 在独立进程运行；分发时用 `@yao-pkg/pkg` 编成独立可执行文件（内嵌只带英文区域数据的 Node），作为 Tauri 的 externalBin。
3. 宿主和 sidecar 经 stdin/stdout 每行交换一条 UTF-8 JSON，格式在 `src/sidecar/protocol.ts`。界面只能调用一个 Tauri 命令，由它把通道请求转给 sidecar；capability 限定只有主窗口里的应用页面能调用。sidecar 不为界面开本地端口。
4. 目录选择器、打开文件夹、窗口明暗由 Rust 宿主应 sidecar 的 `host-request` 提供。
5. 关闭窗口时宿主先请求 sidecar 停止服务，成功后退出；失败时显示 sidecar 给出的提示并保持运行。sidecar 意外退出时宿主提示后退出。宿主退出或崩溃导致 stdin 关闭时，sidecar 停止服务后自行退出。

### 分发

6. Windows x64 发布 NSIS 安装包和免安装 zip 两种。zip 里主程序和 sidecar 放在同一文件夹。Linux 的分发形式见 [ADR-0007](ADR-0007-linux-desktop.md)。

### 存储目录

7. 目录名统一为 `galgame-savedata-sync`。宿主按平台算出配置、数据、备份库、缓存四个目录，用命令行参数传给 sidecar；不使用 Tauri 按应用标识生成的目录，也不读取 Electron 版的数据目录。

| 内容 | Windows | Linux |
| --- | --- | --- |
| 界面偏好（主题、语言） | `%APPDATA%\galgame-savedata-sync\` | `~/.config/galgame-savedata-sync/` |
| 设备身份、目录登记、游戏库、端口、备份设置、中断写入标记 | `%LOCALAPPDATA%\galgame-savedata-sync\data\` | `~/.local/share/galgame-savedata-sync/data/` |
| 默认备份库 | `%LOCALAPPDATA%\galgame-savedata-sync\backups\` | `~/.local/share/galgame-savedata-sync/backups/` |
| 传输缓存、WebView 数据 | `%LOCALAPPDATA%\galgame-savedata-sync\cache\` | `~/.cache/galgame-savedata-sync/` |

8. Roaming 只放和机器无关的界面偏好。设备身份、目录登记（含 dev/ino 身份）和游戏库只对本机有效，放 Local。
9. 设备身份单独存一个文件 `identity.json`，不和目录登记放在一起；其他数据文件损坏时设备 ID 保持不变。数据文件读不懂（损坏或格式版本不符）时改名为 `<名称>.unreadable-<UTC 时间>.<扩展名>` 留在原处，用默认值启动，界面提示一次并给出打开数据目录的入口；只有读取或改名遇到文件系统错误时才停止启动。
10. 缓存根下的内容随时可以删除，应用下次需要时重建。

### 便携模式

11. 主程序所在文件夹里存在 `portable_data` 文件夹时进入便携模式：配置、数据、默认备份库和缓存都放在它下面的 `config\`、`data\`、`backups\`、`cache\` 里，不读写系统目录。应用不主动创建 `portable_data`，由用户自己建；zip 包里不带这个文件夹。Linux 上 AppImage 按 `.AppImage` 文件所在的文件夹判断，deb 安装版不支持便携模式（[ADR-0007](ADR-0007-linux-desktop.md)）。

### 备份库位置

12. 备份库指全部游戏备份所在的整个文件夹，默认是数据根下的 `backups`（便携模式下是 `portable_data\backups`）。设置页可以用系统选择器把整个备份库换到别的文件夹，作用于所有游戏；只有桌面端提供，移动端没有这项设置。
13. 换位置不搬已有的备份。应用只列出当前备份库里的备份；旧位置的备份留在原处，换回原位置后重新列出。换位置前界面提示这一点。
14. 备份库和任何同步目录不能互相包含，选择备份库和选择同步目录时都检查。
15. 启动时备份库不可用（如移动硬盘未连接）不影响启动；开着备份的游戏传输时报备份库不可用并拒绝开始，不改用其他位置。

## 原因

- 后端整体复用，不用 Rust 重写，两端协议和文件安全逻辑只有一份 Node 实现。
- stdin/stdout 只在宿主和 sidecar 之间可见，不需要令牌和 CORS，本机其他程序连不上。
- 系统 WebView 不随应用分发浏览器内核。
- 设备 ID 漫游会让两台电脑在对端看来是同一台设备；按 Roaming、Local、缓存分开后，Windows 和 Linux 能套同一套规则（Linux 对应 XDG 的 config、data、cache）。
- 便携模式按存在的文件夹判断，exe 放在只读位置（如 `Program Files`）时不会尝试写入旁边的目录。

## 影响

### 正面影响

- 分发包不含 Chromium。
- 设备身份、备份和缓存不放在 Roaming。
- 备份库可以放到容量更大的盘上。

### 负面影响

- 构建需要 Rust 工具链和 MSVC 生成工具，CI 也要加。
- 分发包里有主程序和 sidecar 两个可执行文件，不能再出单文件免安装 exe。
- 监听端口的是 sidecar，Windows 防火墙弹窗和规则对应 sidecar 的可执行文件。
- sidecar 仍带完整的 Node 运行时。
- 界面运行在系统自带的 WebView2 上，版本由系统决定，界面要在 WebView2 上重新验收。
- Electron 版的数据不迁移，升级后需要重新添加游戏和设备。

## 替代方案

| 方案 | 优点 | 缺点 | 结果 |
| --- | --- | --- | --- |
| 继续用 Electron | 无迁移工作 | 分发包带 Chromium；数据仍在 Roaming | rejected |
| 后端用 Rust 重写 | 单一可执行文件 | 工作量大，协议和文件安全逻辑要重新实现和验收 | rejected |
| sidecar 开本地 HTTP 端口，界面直接调用 | 不经 Rust 转发 | 本机其他程序能访问端口，需要令牌和 CORS | rejected |
| 全部数据放 Roaming | 和 Electron 现状一致 | 设备 ID 漫游，备份体积大 | rejected |
| 免安装版默认把数据放在 exe 旁边 | 不用建文件夹 | exe 在只读位置时写不了；用户不知道数据在哪 | rejected |
| 换备份库时搬走已有备份 | 旧备份继续列出 | 大量复制，中途失败要能续搬 | rejected |

## 相关文件

| 文件 | 说明 |
| --- | --- |
| `apps/desktop/src/backend/backend.ts` | 后端启动、宿主接口 `DesktopHost` 和停止顺序 |
| `apps/desktop/src/sidecar/index.ts`、`protocol.ts` | sidecar 入口和 stdio 消息格式 |
| `apps/desktop/src-tauri/` | Tauri 宿主 |
| [桌面端平台层](../architecture/desktop.md) | 桌面端结构、接口和生命周期 |
