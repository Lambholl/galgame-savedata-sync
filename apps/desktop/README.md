# Windows 目录、归档、HTTP 与新文件发布

## 目录

- [1. 范围与入口](#1-范围与入口)
- [游戏与设备界面](#游戏与设备界面)
- [Windows 分发包](#windows-分发包)
- [系统明暗主题](#系统明暗主题)
- [2. 主进程接口](#2-主进程接口)
- [3. 有限 IPC](#3-有限-ipc)
- [4. 配置与路径边界](#4-配置与路径边界)
- [5. 验证](#5-验证)
- [6. 私有归档接口](#6-私有归档接口)
- [7. 缓存与格式边界](#7-缓存与格式边界)
- [8. HTTP 服务与任务生命周期](#8-http-服务与任务生命周期)
- [9. HTTP 验证边界](#9-http-验证边界)
- [10. 原生新文件发布](#10-原生新文件发布)
- [11. HTTP 接收与批次结果](#11-http-接收与批次结果)
- [12. 独立备份与恢复材料](#12-独立备份与恢复材料)
- [13. 受保护目标写入与本机恢复](#13-受保护目标写入与本机恢复)

## 1. 范围与入口

`src/main/directory-adapter.ts` 提供 Windows 本机的目录登记、恢复、当前层元数据和原生只读文件流。界面通过系统选择器选择目录，支持切换根目录、进入子目录、返回和刷新；文件夹大小显示“—”，未知文件属性显示“未知”。

目录读取模块保持源只读；私有归档负责快照、编解码和缓存清理；HTTP 服务负责设备/目录查询、双向批次传输及状态/取消。桌面提供服务启停、实际地址/端口、目录选择、任务状态、取消和清理重试。传输由手机发起，接收时在游戏配置的存档目录创建新文件，同名目标报错。

## 游戏与设备界面

新增设备默认使用对端设备名称。电脑报告系统计算机名称；Android 优先报告系统设备名称，取不到时使用型号。重新连接保留已经保存的自定义名称。

左键单击或右键单击游戏卡片，都打开该游戏的操作菜单。

添加游戏会打开弹窗，点击“选择存档目录”直接选择文件夹，随后显示游戏名输入框，默认填入父目录名，可以修改后确认添加；取消不会创建游戏。从对端导入游戏时也先选择本机目录。选择目录即同意在该目录接收文件，重启后沿用配置，接收前会重新检查目录身份和写权限。

桌面独立界面位于 `src/renderer/src/app` 和 `features`，通过 `src/renderer/src/platform/library-adapter.ts` 接入有限 IPC；业务规则从 `apps/shared` 导入。主导航为设备、游戏和设置；游戏操作面板提供目录设置、传输页与任务入口。目录设置用可换行文本显示完整路径，旁边有选择目录按钮；地址用只读 Input 配复制按钮。文件列表始终左右并列，显示分钟级修改时间，元数据直接显示。

开发命令 `pnpm dev` 已启用主进程和 preload 变更监听。更改前已启动的开发进程需要退出后重新运行一次；只刷新页面不会替换旧主进程中的弹窗逻辑。

游戏与设备配置保存在应用私有目录的 `game-library.json`。一个游戏保存本机一个目录，关联多个对端游戏；首期只接纳一台在线手机。手机通过 `POST /v1/catalog` 提交目录引用并取回电脑目录表，8 秒内应答当前层目录查询；15 秒无元数据更新视为离线。运行传输时仍保留现有的单活动批次限制。

电脑只设置本机目录；手机的目录由手机设置后交换公开引用。断开只结束本次连接，手机之后可以重新连接。设备断开/移除不删除存档；移除游戏或更换目录后，原目录不再作为该游戏的接收目标。当前文件操作仍是新文件传输；覆盖、删除与备份恢复按后续里程碑开放。

保存游戏配置会核对目录是否已在本机选择器中登记；传输进行中先结束任务，再修改游戏目录或关联。设备改名保留原项目关系，重启继续读取同一份配置；失效目录保留记录并提示重新选择。

## Windows 分发包

在 Windows 上从仓库根目录运行 `pnpm desktop:package`，先编译桌面资源，再用 electron-builder 生成 x64 分发包：

- `release/SavedataSync-0.1.0-Setup-x64.exe`：安装版，可选择安装目录，安装结束后手动启动。
- `release/SavedataSync-0.1.0-Portable-x64.exe`：免安装版。

以上路径相对 `apps/desktop`，文件名版本来自桌面 `package.json`。当前构建未签名。卸载保留应用配置。

打包脚本将已编译的 `out/` 和最小应用清单复制到 `.reports/` 下的新暂存目录，隔离工作区依赖；使用本机 Electron 分发文件，缺少时由打包器下载。安装包、免安装包及暂存资源不纳入 Git。

## 系统明暗主题

当前界面默认跟随 Windows 系统外观。Renderer 首次渲染读取 `prefers-color-scheme`，运行时订阅变化并切换 antd 的 `defaultAlgorithm`/`darkAlgorithm`，组件卸载释放监听。页面初始底色及原生 `BrowserWindow.backgroundColor` 同步采用对应明暗底色；原生主题监听在窗口关闭时释放。

主题使用现有组件库的语义色，目录与传输接口不受影响；手动主题开关和偏好持久化还没做。

当前递归扫描由 `WindowsSyncScanner` 提供：构造时传入本机目录适配器，`start(rootId)` 返回扫描句柄，`get(scanId)` 查询，`cancel(scanId)` 显式取消，退出时 `await stop()` 等待关流。原生验证可收紧 maxEntries/timeoutMs/retentionMs，不能放宽固定预算；失败使用脱敏 OperationError，结果只存当前会话。

HTTP 服务注入 `scanSource: adapter` 后开放 `/v1/sync/capabilities`、`POST /v1/sync/scans` 和 `GET/DELETE /v1/sync/scans/{scanId}`。请求遵守会话头及严格 JSON，登记只接收 `{ schemaVersion: 1, rootId }`，202 后查询实际结果；旧批量接口保持非覆盖。扫描能力为 supported，复制、备份与恢复目前为 unsupported。

有限 `desktopService.startScan(rootId)`、`queryScan(scanId)`、`cancelScan(scanId)` 返回 `OperationResult<SyncScanState>`，桥会核对请求引用与返回句柄，主进程继续校验窗口来源和封闭参数。扫描复用原生只读流，前后重查文件/目录变化，空目录单独表示，目录大小恒为 null；完成结果保留最多 10 分钟，停止/重启服务使旧句柄失效。

## 2. 主进程接口

| 接口 | 输入/输出 | 生命周期与失败 |
| --- | --- | --- |
| createDirectoryAdapter(configPath) | 主进程控制的绝对配置路径，返回适配器 | 不存在时创建身份；损坏/未知 schema、无效文件或权限失败抛异常，不重置原配置 |
| adapter.deviceId | 返回安装内稳定设备 ID | 与 IP 无关，不从机器 MAC 生成 |
| adapter.registerDirectory(path) | 仅系统选择器/受信任本地调用传入绝对目录；返回 OperationResult&lt;DirectoryReference&gt; | 配置保存后才更新内存；再次明确选择同一路径保留 rootId，重新核实身份并清除该根的旧条目引用 |
| adapter.listRoots() | 返回公开根引用列表 | 重查根身份；失效根标 unavailable，并保留配置 |
| adapter.listDirectory(rootId, parentId=null) | 当前层 DirectoryListing | 根层 parentId=null；子层必须使用已采集目录的 entryId。只读当前层，不汇总目录大小；不支持的链接/类型及读取失败返回错误 |
| adapter.openFile(reference) | 本进程有效的 EntryReference，返回 metadata、Node Readable 和 verifyUnchanged() | 调用者消费/关闭流后调用检查点，重查原身份、大小、mtime/ctime；不重新读内容。可观察的身份、大小和时间变化会发现，中途同大小改写可能漏过；流自动关闭句柄 |
| adapter.assertCacheIsolated(path) | 仅主进程传入缓存绝对路径 | 拒绝缓存与任何已登记根互相包含；只做隔离检查，不创建目录，也不向 IPC 暴露路径 |

除初始化工厂外，异步操作失败均返回稳定错误包络；内部 `DirectoryAccessError` 保留 cause，IPC 只输出脱敏后的 code/message/canRetry，不包含主机路径、堆栈或文件内容。

```ts
// 受信任主进程示例；配置必须位于源目录之外。
import { createDirectoryAdapter } from './src/main/directory-adapter.ts'

async function inspectChosenDirectory(configPath: string, chosenPath: string): Promise<void> {
  const adapter = await createDirectoryAdapter(configPath)
  const selected = await adapter.registerDirectory(chosenPath)
  if (selected.status === 'error') throw new Error(selected.error.message)
  const listing = await adapter.listDirectory(selected.value.rootId)
  if (listing.status === 'error') throw new Error(listing.error.message)
  // UI 仅展示本次条目；不得把它保存为下次同步的共同历史基线。
  console.log(listing.value.entries.length)
}
```

## 3. 有限 IPC

preload 通过 `window.desktopDirectories` 暴露冻结的 `DesktopDirectoryApi`：

- `chooseDirectory()`：无参数，主进程打开系统选择器；取消返回 cancelled 并保留既有根。
- `listRoots()`：无参数，只返回公开根描述。
- `listDirectory(rootId, parentId?)`：默认根层；仅接受不透明 ID，不接受名称或路径。

固定通道为 directories:choose、directories:roots、directories:list。主进程检查窗口登记、主 frame 身份及精确 renderer URL；选择器返回后再次核实来源。子 frame、导航后的页面、额外参数、非法 ID 和附加路径字段均被拒绝。preload 另检查输入和响应结构，异常映射为脱敏错误；不会暴露 ipcRenderer、通用 invoke、Node 句柄或文件字节。

应用退出时移除 handler，窗口关闭时删除可信窗口记录；应用采用单实例锁，常态下只有一个实例更新配置。该包只提供三个请求式方法，没有事件订阅；网页调用者不持有需要释放的文件句柄。

服务控制另由 `window.desktopService` 的冻结 `DesktopServiceApi` 提供：`status()`、`start(port)`、`randomizePort()`、`stop()`、`chooseTarget()`、`revokeTarget(rootId)`、`cancel(transferId)`、`retryCleanup()`。固定通道与响应守卫在 `src/bridge/service-bridge.ts`，主进程来源/参数校验在 `src/main/service-ipc.ts`。`start` 接受 1 到 65535 的整数，本机显式启动后监听 `0.0.0.0`，冲突返回错误。端口保存到应用私有目录，首次生成 49152 到 65535 的随机值；`randomizePort()` 选择并保存另一个端口。快照含配置端口、实际监听地址、运行错误、本进程接收根和当前会话任务；没有 sessionId、私有路径或文件内容。

`chooseTarget()` 打开原生系统选择器；选中目录后执行 `publisher.grant`，取消保留既有授权。`revokeTarget` 撤销新写入授权并收尾该根的当前发布。其他操作返回 `OperationResult<DesktopServiceSnapshot>`；选择器返回 `DirectorySelectionResult`。全部 Promise 将失败转为脱敏错误，无事件或原生句柄需要调用者释放。界面每秒读取状态，卸载停止轮询。`getStates()` 只取当前会话快照，不延长任务保留期；`cancel()` 保留已经发布的文件。

## 4. 配置与路径边界

应用在 `app.getPath('userData')/directory-config.json` 保存 schemaVersion=1、deviceId 与 roots。内部根记录仅含 rootId、规范路径和 bigint dev/ino 的字符串身份；绝对路径不传到 Renderer，也不写进项目记忆。条目 ID/相对路径映射只在本进程内有效，不保存历史元数据或哈希，重启后重新枚举。

应用启动先创建并解析系统提供的 userData 实际位置，再初始化配置和私有缓存，以兼容系统目录重定向。用户选定的存档根仍执行逐段路径、链接和身份检查。

配置写入使用同目录独占临时文件、sync 和 rename；同进程登记串行处理，成功前不更新内存。配置必须位于所选根目录之外；目录损坏或版本未知时停止初始化。配置目录由应用控制，跨外部进程的配置事务或锁不在当前实现内。

每次读取重新检查根身份；路径逐段 lstat，拒绝 symlink/junction，核对 realpath 与根范围，读取句柄再核对身份。文件/目录替换使旧引用失效，需要刷新或明确重新选择。当前策略拒绝所有遇到的链接，不跟随根内链接；不支持的条目会让该层读取返回错误，不显示成空目录。

Node 的路径检查与文件打开是两个操作。本实现检查可观察到的替换和越界；外部进程恶意并发重排命名空间时，当前实现不提供内核级隔离，也不提供目录级原子替换。内容哈希与源变化校验由下述私有归档模块处理，写入授权和发布竞争由第 10 节的独立原生发布模块处理。

Electron 构建显式内联 workspace 共享包，避免 sandbox preload 在运行时 require TypeScript 源码。preload 保留 CJS 输出，contextIsolation/sandbox 开启，Renderer 无 Node 集成。

## 5. 验证

`pnpm test:desktop` 执行目录/IPC、归档、HTTP 和发布的最小长期回归，不纳入 `pnpm check`。测试只覆盖公开接口、数据关系、文件安全和关键传输结果；界面、日志文本和内部调用顺序不进入长期测试。临时夹具基于 realpath 的系统临时根，不记录真实存档路径。

Windows 短路径检查通过 PowerShell 调用 GetShortPathName，生成真实 8.3 别名，并在只影响子进程的 TEMP/TMP 环境中重跑目录与 IPC 用例。非 Windows 或卷未生成不同短名时会跳过这一项，常规用例继续执行。这里只调整测试夹具，业务代码的链接、根范围和身份检查保持不变。

额外只读验证通过用户授权的真实 Windows 目录执行：读取前后文件内容哈希、条目和目录修改时间一致，原生读流一致，配置恢复成功；具体路径及文件哈希不进入仓库。Android、HTTP 传输、原生选择器人工点击和完整界面由对应专项验收。

参考：[Node 文件系统](https://nodejs.org/docs/latest-v22.x/api/fs.html)、[Electron IPC 来源校验](https://www.electronjs.org/docs/latest/tutorial/security#17-validate-the-sender-of-all-ipc-messages)、[系统目录选择器](https://www.electronjs.org/docs/latest/api/dialog)。

## 6. 私有归档接口

`src/main/archive-adapter.ts` 仅供主进程调用，使用内置 fs/stream/zlib/crypto，无新增依赖。HTTP 下载准备/发送及上传接收/全原文校验会复用此模块。文件、缓存和流留在原生层，归档对象和文件内容不跨 preload/JS 桥。

| 接口 | 输入/输出 | 所有权与失败 |
| --- | --- | --- |
| createWindowsArchiveAdapter(source, privateDirectory, options?) | 目录读取适配器与既有应用私有绝对目录；返回归档适配器 | 缓存固定放 transfer-archives-v1 子目录，不能与任何已登记源根重叠；启动只清理验证过的孤儿缓存；失败抛脱敏 ArchiveError |
| archive.prepare(request, options?) | DownloadBatchRequest，返回 WindowsArchive | 按流复制源至私有快照，实测长度/SHA-256并核实读取后元数据，再打包 gzip1；成功后调用者持有缓存，必须 dispose |
| archive.receive(manifest, input, options?) | BatchManifest 和原始 Node Readable；返回 WindowsArchive | 从调用起接管并最终关闭 input；完整保存/校验压缩体及全部原文后才返回句柄；失败不提供可发布结果 |
| artifact.manifest | 冻结的本次清单、实际长度/哈希 | 当前任务专用，不持久化为历史基线；不同压缩器会生成不同字节，接收端以本次清单为准 |
| artifact.openArchive() / openFile(fileId) | 只读流；fileId 必须属于本清单 | 调用者必须消费或 destroy；未关闭读流会使 dispose 报 busy；不返回缓存路径 |
| artifact.dispose() | Promise&lt;void&gt; | 幂等并合并并发清理；失败保留互斥，禁止新任务，允许再次 dispose 或 retryCleanup |
| archive.retryCleanup() | 重试本缓存根的失败清理 | 不删除其他缓存根或仍在操作/仍有读流的任务；清理成功后才释放进程互斥 |

操作 options 可传 signal 和 onProgress；期限由上层管理，预先/处理中取消均关闭可中断的流。普通 abort 抛 ArchiveCancelledError，TimeoutError signal 映射 timeout；若清理也失败，原错误保留，独立 cleanupError=cleanup-failed。普通 ArchiveError 的 operationError 只含共享稳定码/脱敏消息，内部 cause 不传到界面。

进度快照分开源读取、压缩体已暂存、原文校验字节与已校验文件数。暂存、解包和目标发布是三个不同阶段，只有文件结果表示最终发布。回调由原生任务调用，不在 Renderer 执行 IO；抛异常会中止并清理任务。

## 7. 缓存与格式边界

默认执行共享包的每文件/总原文/tar/压缩体上限、64 KiB 显式 IO 缓冲及 3 GiB 私有缓存预算。options.quota 可以进一步收紧本机预算，上限仍沿用协议值；options.io 仅供受信任主进程注入磁盘空间检查和删除能力。接收登记前检查压缩体、解包原文和整批目标文件的可用空间，缓存与目标同卷时合计峰值，不足返回 `insufficient-space`。每次写入继续计数和检查余量，写入失败按实际 IO 错误处理。满额 1 GiB 双向传输和进程内存实测见[规模验收](../../docs/validation/m001-resources.md)。

源快照和解包只写到随机任务目录。根/任务都有所有权标记并检查目录身份，进程内一份活动缓存，成功句柄未释放也会占用名额。清理先核实所有成员，再逐个 unlink 普通文件并 rmdir 空任务目录；拒绝陌生文件、子目录、链接和多重硬链接，不递归展开归档路径。所有权或初始化身份无法确认时停止操作；外部恶意并发重排私有命名空间不在防护范围。

归档严格按[批量协议](../../docs/plans/m001-tar-gzip-protocol.md)的规范化 USTAR 头、顺序 fileId、零填充和两个结束块生成/校验。gzip 限制固定头和单 member，使用原始 DEFLATE 解码并核对实际消耗字节、CRC32/ISIZE、完整 tar 长度及每文件 SHA-256；拒绝拼接、尾随、损坏、截断、链接及扩展头。全体验证通过后才返回私有句柄。目标新文件发布及 HTTP receiver 编排已经可用，双端实际 LAN 的结果见移动说明。

`test/fixtures/archive-v1.json` 由 Python 标准库独立生成，包含三份合成原文、规范 tar 和 gzip；测试验证 Node 编码的 tar 精确匹配独立预期，也验证 Node 解码 Python gzip，后续 Java 包复用这份夹具。测试中的完整 Buffer/gunzipSync 仅用于小夹具，产品路径使用有限缓冲流式 IO。

## 8. HTTP 服务与任务生命周期

`src/main/http-service.ts` 提供可信主进程调用的 `WindowsHttpService`；构造对象时不会监听网络。应用初始化目录/归档/服务对象，用户点服务按钮后通过有限 IPC 启动，退出时等待 stop。原生 API 缺省回环地址和动态端口，桌面按钮显式选择 LAN 监听；自动化 HTTP 检查使用 127.0.0.1。

| 原生 API | 输入/返回 | 责任 |
| --- | --- | --- |
| new WindowsHttpService(source, archive, options?) | 目录读取/归档适配器；可选 publisher、displayName、时钟、仅收紧的期限/会话容量 | 不改变目录授权；同时有 publisher 及 archive.receive 才启用上传，目标须单独本机写授权；网络层只使用 Node 内置 HTTP/流/哈希 |
| service.start({host?, port?}) | host 为 IP 地址，默认 127.0.0.1；port 默认 0；返回实际 host/port/sessionId | 端口冲突明确失败，不换端口重试；启动/停止并发受限；每次重新启动生成会话 |
| service.getAddress() / getError() | 监听快照或 null；脱敏运行时错误或 null | 设备身份用 deviceId；sessionId 只用于识别服务重启，认证不在这层 |
| service.stop() | Promise&lt;void&gt; | 停止接纳、关闭连接、取消并等待 worker/缓存清理；并发 stop 共用 Promise；失败保留所有权，下次 stop 重试 |
| service.retryCleanup() | Promise&lt;void&gt; | 主进程明确重试终态缓存；活动任务报 busy；不重放请求或内容 |

```ts
import { WindowsHttpService } from './src/main/http-service.ts'

// 在可信主进程的本机服务控制操作中调用；source/archive 为已初始化的适配器。
const service = new WindowsHttpService(source, archive)
const listening = await service.start({ host: '127.0.0.1', port: 0 })
console.log(listening.port)
await service.stop()
```

HTTP 已实现设备、根/当前层、POST downloads、GET manifest/content、GET/DELETE transfer；注入 publisher 后另支持 POST uploads 和单次 PUT content；路由和包络见[批量协议](../../docs/plans/m001-tar-gzip-protocol.md#4-http-路由与会话)。除了 device 均核对唯一会话头。JSON 严格 UTF-8、无 BOM/重复解码键、深度不超过 128，按实际 UTF-8 字节执行 8 MiB 请求及响应预算；拒绝编码体、trailer、重复头、歧义 CL/TE、非法/重复查询、错误方法和 Range。JSON 可固定长度或 chunked；gzip 响应固定长度及 SHA-256，无 Content-Encoding，不缓存。

`transfer-registry.ts` 原子接纳后占用单次 ID；下载内容仅 sender ready 可原子领取一次；上传内容只允许 receiver awaiting-content，见第 11 节。每个进程仅一个活动批次，覆盖准备、ready、发送、取消和清理；即使构造多个监听实例也共享名额。ready 10 分钟、总期限 30 分钟、发送无进展 60 秒，查询不续期；另有限制请求/响应无进展 60 秒、整个 HTTP 请求 30 分钟、请求头 15 秒及 16 KiB 头预算。终态保留 10 分钟，随后删除状态与清单/哈希，已用 ID 保留到服务停止；最多 4096 个，不淘汰防重记录。

归档从固定私有快照发送，发送时再核对实际长度/SHA-256。进度区分源读取和写入 HTTP 流的归档字节；sender 的校验/发布计数始终为 0，sent 表示本机发送流完成，Android 是否接收或发布要看 receiver 的结果。失败、取消和超时等待实际 IO 结束再清理；原始失败与清理错误分开。清理失败保留互斥，即使公开结果到期仍阻止新任务，明确重试成功后才释放。

主进程 before-quit 同时等待 HTTP 服务与发布适配器停止，成功后继续退出；清理失败显示错误并保留重试机会。页面通过固定服务方法启停、授权、取消和重试清理；文件路径、字节和发布流由原生层持有。

## 9. HTTP 验证边界

`test/http-service.test.mjs` 使用真实回环 HTTP/TCP 和独立临时源/缓存，覆盖下载内容与哈希、异步状态、单次领取、路由/会话、取消、清理、停止与重启。时间边界由原生时钟与仅收紧的期限注入，不等待实际 30 分钟；大归档内存与性能仍需专项实测。

这些检查覆盖 Windows sender 与服务原语；receiver 见第 11 节。实际桌面窗口、系统选择器、Android LAN 双向、取消、清理重试和界面结果已通过真机验收。应用默认停止服务，真实存档保持只读。

## 10. 原生新文件发布

`src/main/new-file-publisher.ts` 的 `WindowsNewFilePublisher` 是独立主进程能力；目录读取登记、应用启动和 HTTP 查询均不授予写权限。构造不写文件，写授权只在本进程存活；退出会撤销授权、取消未发布操作并等待候选清理。仅在本机明确授权的专用测试根中使用，真实存档保持只读。

| 原生 API | 输入/返回 | 生命周期与失败 |
| --- | --- | --- |
| new WindowsNewFilePublisher(source, options?) | 目录适配器；可选 maxFileBytes 及受信任 IO 注入 | 文件预算只能收紧 256 MiB 协议上限；不支持安全硬链接时失败，不降级覆盖 |
| grant(rootId) / revoke(rootId) | 已登记本地根 ID；Promise&lt;void&gt; | 显式本机授权；撤销等待正在操作的原生 worker；新实例没有旧授权；读取桥能力仍保持只读 |
| checkTarget(request) | 只读预检，返回物理父目录 dev/ino 与大小写比较键 | 验证授权、父目录、预算及当前同名项，供后续 receiver 预检/批次去重；不预留名称，发布时仍重查 |
| publish(request, input, options?) | 原文 Readable、可选 signal/同步 onProgress；返回 outcome 与清理状态 | 接管并最终关闭输入；非法请求抛 PublicationError，有效请求返回共享 FileOutcome；未确认结果为 unknown，不自动重放 |
| retryCleanup() / stop() | Promise&lt;void&gt; | 清理失败保留身份和进程名额；明确重试成功后释放；并发清理/停止共用相应操作；stop 失败可再次 stop |

request 为封闭对象 `{fileId, rootId, parentId, name, sizeBytes, sha256}`。名称使用共同创建约束，parentId 为已有父目录或 null；不接受路径、目录创建、覆盖或批次执行。目录适配器新增的 `locateNativeDirectory` 只提供原生路径、身份复验和已知身份文件的元数据登记，本身不写文件，也不跨 preload。

```ts
import { WindowsNewFilePublisher } from './src/main/new-file-publisher.ts'

// source、targetRequest 与完整校验后的 verifiedArchive 由可信主进程提供。
const publisher = new WindowsNewFilePublisher(source)
await publisher.grant(targetRequest.rootId)
await publisher.checkTarget(targetRequest)
const result = await publisher.publish(
  targetRequest,
  await verifiedArchive.openFile(targetRequest.fileId),
)
console.log(result.outcome.status, result.cleanupStatus)
await publisher.stop()
```

发布在目标父目录以 `wx` 创建随机 `.savedata-new-<UUID>.tmp` 候选，因此候选和最终文件在同一卷；输入按不超过 64 KiB 分块、检查可用空间，实测长度/SHA-256、sync 并关闭后才进入发布点。最终名称通过 `fs.link(candidate, target)` 排他创建；同名检查用于早期反馈，实际不覆盖保证由 link 提供。成功后读取最终文件至 EOF，复验身份、属性、长度及 SHA-256，再登记实际元数据。只有此时报告 succeeded；候选 unlink 只移除临时名称，保留最终文件。

硬链接及卷限制参见 [Node fsPromises.link](https://nodejs.org/docs/latest-v22.x/api/fs.html#fspromiseslinkexistingpath-newpath)、[Windows CreateHardLinkW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createhardlinkw)。当前验证范围是本机临时卷；其他卷或网络文件系统要另行验收，无法安全硬链接时发布失败。比较键使用物理父目录身份及小写名称，排他创建交给文件系统；特殊 Unicode/8.3 名称的覆盖还没补齐。

发布点前取消会关闭输入并清理候选；link 成功后完成有界回读，按实际结果报告成功或 unknown，已经 link 成功的最终文件会保留。发布已经发生但回执、身份或回读无法确认时，保留当前最终条目并返回 result-unknown；查询失败时目标可能已经写入，要重新核实。清理失败独立于成功/失败/取消结果，确知属于本次的残留可返回引用；引用为空只说明没有已知残留。

同进程只允许一个原生发布操作或待清理候选，名额与归档缓存独立，允许 receiver 持有已校验归档并逐文件发布。候选删除前重新验证父目录、普通文件及原身份；身份被替换时停止清理，保留互斥，不删除未知条目。进度只报告候选写入、最终回读与已确认发布的字节，不应重复累加为批次归档校验进度。

`test/new-file-publisher.test.mjs` 覆盖真实非覆盖发布、已有/竞争文件保护、流长度与哈希、取消、unknown 和清理重试。每项复验独立只读源的内容和属性；Windows HTTP 接收及批次部分发布另见第 11 节。

所有权与写授权只在当前进程内有效。崩溃或强制退出可能留下目标卷候选；重启后会保留现状，由人核实，不按名称猜测或删除，也不恢复旧任务。正常退出、失败和取消时的进程内清理及满额 1 GiB 资源实测已通过；跨进程候选恢复、真实断电及其他文件系统仍待验证。Node 路径检查不提供对恶意并发重排命名空间的内核级隔离。

## 11. HTTP 接收与批次结果

可信主进程通过 `new WindowsHttpService(source, archive, { publisher })` 启用 Windows receiver；archive 须支持 receive。未注入时服务保持只读。设备能力表示是否有接收适配，实际目标仍须由本机 `publisher.grant(rootId)` 授权。HTTP 没有 grant、任意路径或远程覆盖入口。当前应用初始化时注入适配器；用户在游戏目录设置中选中本机目录后，应用授予该目录本次进程的写权限。

```ts
// source、archive 和专用测试根由可信主进程准备；写权限不从网络请求取得。
const publisher = new WindowsNewFilePublisher(source)
await publisher.grant(testRootId)
const service = new WindowsHttpService(source, archive, { publisher })
const listening = await service.start({ host: '127.0.0.1', port: 0 })
console.log(listening.port)
await service.stop()
await publisher.stop()
```

POST uploads 严格验证 ReceiveBatchRequest，逐项调用只读目标预检，并以物理父目录/小写名称键检查重复实际目标。异步预检期间保留进程名额，同 ID 并发只接受一次；失败不占已用 ID，成功后进入 awaiting-content 并返回 201。源端引用只作清单上下文，不解析成本机路径。201 表示任务已登记；此时还没有归档，也没有写入文件。

PUT content 只允许 receiver awaiting-content，校验唯一的 application/gzip、Content-Length 和 x-archive-sha256 与已登记压缩体一致；拒绝 Transfer-Encoding、Content-Encoding、Range、歧义头和非法参数。头校验成功后在任何 await 前领取唯一内容入口。接收通过不超过 64 KiB 的输入桥流向原生归档，按背压暂停/继续读取；取消、连接断开或超时显式结束接收等待，不依赖下一块数据到达。

`ArchiveReceiveOptions.onArchiveStored` 是原生检查点，只在压缩体完整落盘、正常消息结束且长度/SHA-256 匹配后触发。HTTP 在此返回 202 的 verifying 快照；此时 gzip、tar、CRC 和逐文件原文还没全部确认。归档适配继续异步完成受限解包和完整校验，返回已验证句柄后，`upload-receiver.ts` 才按清单顺序调用独立发布模块。整批校验失败时不发布目标，结果全部为 not-attempted/batch-invalid；用户取消则标明 cancelled。

任务注册表复用 sender 的会话、单次 ID、通用查询/取消和进程名额，receiver 等内容期限为 2 分钟，总期限 30 分钟、网络无进展 60 秒。查询不续期；终态/清单保留 10 分钟后清除，已用 ID 保留到服务停止。完整消息收齐后，即使响应连接丢失，本机仍继续校验和发布；调用者查询实际结果，POST/PUT 不重放。服务重启会清除会话任务，不恢复旧请求；同进程 publisher 的授权独立存活到 revoke/stop，应用退出时两者一起停止。

receiver 的 sourceBytesRead 始终为 0，接收/原文校验/最终发布字节分别计数，文件成功必须匹配本次 SHA-256、根、父目录、名称和实际条目。前项成功、当前失败/取消/unknown 与后项未尝试逐项反馈；首项非成功后停止继续发布。最后一个文件在取消竞争中仍完整发布并回读成功时，按实际结果报告 succeeded；已经发布的文件不回滚。结果 unknown 或残留列表为空时，都可能有未确认写入，要重读目标确认。

发布或缓存清理失败独立报告，已确认成功项不改报未写入；即使全部成功，清理失败仍保留进程名额。前项候选清理阻止继续发布时，已成功项保留，下一项报告无法启动的 cleanup-failed，后项为 prior-failure。明确调用 service.retryCleanup 后才释放任务名额；原生发布和归档各自只清理确知所有权的内容，目标文件不回滚。

`test/http-receiver.test.mjs` 使用独立格式夹具、真实回环 HTTP/TCP 和自有源/目标/缓存，覆盖两阶段确认、单次 PUT、全部校验前零发布、部分失败/取消/unknown、响应丢失、停止与重启。sender 相关回归继续通过，源内容和属性逐项复验。

双端正式 LAN、独立界面以及满额 1 GiB 双向传输和峰值内存已通过验收，见[规模验收](../../docs/validation/m001-resources.md)。其他文件系统、特殊名称等价和跨进程候选恢复仍有缺口。真实存档保持只读。

## 12. 独立备份与恢复材料

`createWindowsBackupStore(adapter, privateDirectory)` 在应用私有持久位置 `backups/` 初始化独立备份。启动时登记为私有目录，目录适配器拒绝把它及其父子目录选作同步根；所有备份访问继续复核根和轮次身份。备份不进入同步比较，清除应用数据或手工删除该目录会丢失备份。

| 原生方法 | 输入、输出和资源责任 |
| --- | --- |
| `settings()` / `setPreference(projectId, rootId, shouldBackup)` | 独立 `SyncBackupSettings`；缺少设置项时使用 true，坏设置拒绝修改并保留原文件；不改变 `LibraryConfig` v1 |
| `create(plan, options?)` | 仅接受有效、可执行且目标设备匹配的 `SyncPlan`，保存 replace-file 对应的全部旧内容；返回 `{ manifest, cleanupError }`，关闭备份或没有覆盖时 manifest 为 null |
| `capacity(requiredBytes)` | 主进程预检私有卷剩余空间，返回所需/可得字节；可得量未知为 null，不足抛 insufficient-space；不提前删除有效旧轮次换空间 |
| `list(projectId, rootId)` | 返回该项目/根的已提交清单和未完成轮次 ID；清单列出不代表文件刚刚重新校验，恢复必须 acquire |
| `acquire(projectId, rootId, backupId, options?)` | 完整核对每个原文文件后返回原生句柄；`manifest` 是清单副本，`snapshot()` 为本次恢复建立临时树，`openFile(fileId)` 返回只读 stream 与 verifyUnchanged；消费者关闭读流后 release |
| `rotate(projectId, rootId)` / `cleanupIncomplete(projectId, rootId, backupId)` | 显式重试轮换或清理已核实归属的未提交/已淘汰轮次；有效备份和正在被恢复引用的轮次不通过残留入口删除 |
| `stop()` | 应用退出时取消正在创建/校验的备份并等待资源释放，关闭持有的恢复流；持久备份留到下次启动 |

创建只写固定私有 fileId，每个文件执行源属性检查、流式大小/SHA-256、落盘和独立回读，再原子提交 `manifest.json`。所有权用 `owner.json` / `round.json` 保存；提交前失败或取消不产生有效轮次。失败抛 `ArchiveError` 或独立 `ArchiveCancelledError`，原始 cause 留在主进程，未清理成功的轮次另附 cleanupError。默认期限 30 分钟，原生 options 可通过 signal 取消或收紧 timeoutMs，读取使用 64 KiB 缓冲。预算、清单和恢复规则见 [M-002 文档](../../docs/plans/m002-sync-copy.md) 第 3 节。

每个项目/目标根保留最近 3 次。新轮可读后才轮换，淘汰前核对保留轮次内容；活动恢复句柄保护输入轮次，release 后再轮换。淘汰先撤下有效清单，再清理已核实文件；失败返回独立 cleanupError，保留可重试的残留或暂时多留的轮次。重启只读取已提交材料，未完成轮次须明确清理，未知条目不自动删除。

```ts
const backup = await backups.create(confirmedPlan, { signal })
// 调用方确认备份成功后，才把该结果交给目标写入模块。
const material = await backups.acquire(projectId, rootId, backupId, { signal })
try {
  const snapshot = material.snapshot()
  // 按 snapshot 生成本次恢复计划；文件通过 material.openFile(fileId) 原生读取。
} finally {
  // 消费者先关闭全部读流，再释放恢复材料引用。
  await material.release()
}
```

有限 `window.desktopBackups` 只提供 read/list/manifest/setPreference/rotate/cleanupIncomplete，输入仅为项目、目录、轮次 ID 和布尔开关。read 的 displayPath 仅供位置展示；列表使用摘要，单轮详情才返回完整清单，控制响应仍限 8 MiB。IPC 核对受信任主窗口/主 frame/URL、封闭参数和返回上下文；不暴露原生句柄、文件内容或私有文件路径参数。备份创建与目标写回由原生 `WindowsSyncWriter` 调用；HTTP 编排与恢复页面分别由 WP-025/WP-027 接入。

## 13. 受保护目标写入与本机恢复

`WindowsSyncWriter(adapter, backups, options)` 执行完整确认计划。主进程的 `authorize(plan)` 每次核对本机项目和目标根；启动实例检查游戏 ID 与 rootId。`WindowsSyncRegistry` 已接入 Android → Windows 的 HTTP 接收、缓存和实际结果查询，原生上传及实际 LAN 已验证。旧 `/v1/transfers/*` 保持只新建语义，新增协议统一见 [M-002 文档第 3.6 节](../../docs/plans/m002-sync-copy.md#36-http-与本地桥)。

| 原生方法 | 输入、输出与资源责任 |
| --- | --- |
| `apply(plan, material, options?)` | 计划须可执行、目标为本机、方向为 android-to-windows 或 local-restore；material 携带匹配的源快照及可重复打开的原生流。非法/过期/重复确认或 busy 抛错误；已接纳任务返回完整 `SyncApplyResult` |
| `prepareRestore(projectId, rootId, backupId, targetSnapshot)` | 完整验证并引用备份，生成强制保护当前内容的恢复计划；返回仅原生使用的 `{ plan, apply, close }`。预览后 apply 或 close，已使用/释放的预览不能执行第二次 |
| `retryCleanup()` | 只清理本进程仍持有、身份匹配的候选；清理完成后释放互斥，不重放文件写入 |
| `checkSpace(plan, privateSpace?)` | 原生接收前合计新文件、完整备份和同卷接收缓存的余量；privateSpace 只来自本机归档适配器，不接收远端容量策略 |
| `stop()` | 停止接纳并取消当前任务，等待原生流/候选和恢复材料释放；应用先停止目标任务，再关闭备份存储 |

本机快照和恢复预览有效期 10 分钟；远端快照由所属会话核实，避免用两端系统时钟差判断远端过期。已接纳任务总期限 30 分钟，可信原生 options 可收紧；signal 显式取消。网络编排通过 lease 借用同一任务 token 和接纳时间，归档准备期间确认继续有效，所有实际目标仍须重扫；编排在写入及缓存清理完成后释放名额。verifyContext 在每次发布前核实设备映射与目标备份设置；onStage/onOutcome 只通知观察结果，观察者异常不改变任务结果。

执行前重新扫描全部目标并核对原始条目 ID、路径、类型、内容和属性；所有待写原文再完整读取核对大小/SHA-256。容量预检把目标新内容、完整旧内容备份及同卷峰值相加，未知容量保持 null。全部覆盖旧内容提交为有效备份后才创建目录、逐文件写入；关闭备份按本次已确认设置执行，本机恢复始终保护被覆盖的当前文件。

`sync-target-files.ts` 复用已验证的新文件发布边界：同卷独占候选、64 KiB 原生流、fsync、独立回读；新建使用无覆盖 link，替换在重查父目录、旧文件身份/日期/哈希及候选身份后 rename。最终长度和 SHA-256 读回通过才报告成功。目录按父子顺序逐个创建，目标独有条目保持原样。目录适配器在同路径对象身份变化时生成新 ID，旧确认不能沿用替换后的对象。

第一次失败/取消/未知后，后续项记为 not-attempted；已经确认成功的内容保留。进入提交点后发生取消，仍读取实际结果；文件或目录已改变却不能完整核实时返回 unknown/result-unknown。候选清理失败独立报告，保留任务名额直到明确清理成功。`target-operation.ts` 与旧批次共用进程互斥，覆盖准备到清理；候选所有权仍只在本进程内有效，崩溃后的残留沿用[已登记的显式核实缺口](../../.project-memory/testing/coverage-gaps.md)。

```ts
// nativeMaterial 提供已验证内容的原生 openFile，不向 Renderer 返回流或路径。
const result = await writer.apply(confirmedPlan, nativeMaterial, { signal })
const preview = await writer.prepareRestore(projectId, rootId, backupId, currentTargetSnapshot)
// 将 preview.plan 的公开数据交给本机确认流程，随后执行同一份预览。
const restored = await preview.apply({ signal })
// 放弃预览时改为 await preview.close()，释放被引用的备份材料。
```
