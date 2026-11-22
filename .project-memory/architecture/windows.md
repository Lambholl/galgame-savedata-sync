---
doc_type: architecture
status: active
updated: 2026-11-22
tags: [Windows, 电脑端, 主进程, IPC]
---

# Windows 平台层

## 目录

- [1. 范围与入口](#1-范围与入口)
- [2. 游戏与设备界面](#2-游戏与设备界面)
- [3. 分发包与应用标识](#3-分发包与应用标识)
- [4. 系统明暗主题](#4-系统明暗主题)
- [5. 目录适配器](#5-目录适配器)
- [6. 有限 IPC 与服务控制](#6-有限-ipc-与服务控制)
- [7. 配置与路径边界](#7-配置与路径边界)
- [8. 当前扫描](#8-当前扫描)
- [9. 私有归档](#9-私有归档)
- [10. HTTP 服务与任务生命周期](#10-http-服务与任务生命周期)
- [11. 写入候选残留](#11-写入候选残留)
- [12. 独立备份与恢复材料](#12-独立备份与恢复材料)
- [13. 受保护目标写入与本机恢复](#13-受保护目标写入与本机恢复)
- [14. 同步结果与本机恢复界面](#14-同步结果与本机恢复界面)
- [15. 测试范围](#15-测试范围)

## 1. 范围与入口

代码在 `apps/desktop`。目录读取模块保持源只读；私有归档负责编解码和缓存清理；HTTP 服务负责设备/目录查询、目录表交换、控制通道和复制任务。桌面提供服务启停、实际地址/端口、目录选择、任务计划与实际结果、备份设置和本机恢复。

电脑作监听方时提供 HTTP 服务和控制通道，接纳拨号方登记的任务；电脑发起的复制经控制通道交给拨号方，对方须开着应用并保持连接，计划在电脑确认、拨号方执行。电脑也能作拨号方连接另一台设备（[ADR-0004](../decisions/ADR-0004-symmetric-listener-dialer-roles.md)）：用 `bonjour-service` 搜索局域网设备，用 `node:http` 和 `ws` 交换目录表、浏览对方目录、保持控制通道，见[第 2 节](#2-游戏与设备界面)。作拨号方时由 `dialer-sync.ts` 的 `WindowsDialerSync` 编排扫描、计划、任务登记、内容上传和下载、取消和结果读取，职责同 Android `SyncTransferEngine`；也处理对方经控制通道发来的 `sync.prepare`、`sync.confirm`、`sync.cancel`、`sync.job.*`，每 0.5 秒推送 `sync.job` 摘要。它和监听方任务共用进程内的写入名额，同一时间只有一个复制任务写入；`sync-ipc.ts` 按本机是否拨号连着所选设备把发起请求交给它或 `remote-sync-requests.ts`，复制任务列表合并两部分，`DesktopCopySummary.localSide` 标明本机是哪一方，传输页和任务详情据此决定方向和两端位置。复制按确认计划执行新增、受保护覆盖、跳过和删除多余项。

Electron 构建显式内联 workspace 共享包，避免 sandbox preload 在运行时 require TypeScript 源码。preload 保留 CJS 输出，contextIsolation/sandbox 开启，Renderer 无 Node 集成。

## 2. 游戏与设备界面

桌面界面位于 `src/renderer/src/app` 和 `features`，通过 `src/renderer/src/platform/library-adapter.ts` 接入有限 IPC；业务规则从 `apps/shared` 导入。主导航为设备、游戏和设置；游戏操作面板提供目录设置、传输页与任务入口。目录设置用可换行文本显示完整路径，旁边有选择目录按钮；地址用只读 Input 配复制按钮。文件列表始终左右并列，显示分钟级修改时间，文件夹大小显示“—”，未知文件属性显示“未知”。

- 新增设备默认使用对端设备名称。电脑报告系统计算机名称；Android 优先报告系统设备名称，取不到时使用型号。重新连接保留已经保存的自定义名称。
- 左键单击或右键单击游戏卡片，都打开该游戏的操作菜单。
- 游戏卡片和移动端一致：三组渐变、居中封面、底部名称/设备数量和箭头。桌面卡片宽 160–180px，封面至少高 152px、信息区至少高 88px，保持竖版；长标题换行，颜色跟随明暗主题。
- 添加游戏会打开弹窗，点击“选择存档目录”直接选择文件夹，随后显示游戏名输入框，默认填入父目录名，可以修改后确认添加；取消不会创建游戏。从对端导入游戏时也先选择本机目录。选择目录即同意在该目录接收文件，重启后沿用配置，接收前会重新检查目录身份和写权限。

游戏与设备配置保存在应用私有目录的 `game-library.json`。一个游戏保存本机一个目录，关联多个对端游戏。同一时间只有一条连接：一台设备连着本机，或本机连着一台设备。连进本机的设备通过 `POST /v1/catalog` 提交自己的目录表并取回电脑目录表，在线状态看 WebSocket 控制通道（`control-hub.ts`）：控制请求 8 秒内要应答，15 秒心跳没有回应按断开处理（`CONTROL_LIMITS`）。运行传输时保留单活动批次限制。

电脑拨号由 `src/main/dialer-session.ts` 的 `WindowsDialer` 负责，`DesktopLibrary` 通过 `LibraryDialer` 接口读取它的在线状态、对方目录和断开：

- 入口：设备页“添加设备”手动输入 `IP:端口`，附近的设备列表和已保存设备的“连接”按钮。电脑不提供扫码。
- 连接：先读 `/v1/device`（5 秒），协议版本不同答复 `protocol-mismatch`，地址是本机或设备 ID 和预期不同时失败；再带 `x-sync-connect: 1` 交换目录表，保存设备和连上的地址，最后连控制通道（`dialer-control.ts`）。交换目录表期间有设备连进本机时撤回这次连接，答复 `busy`。
- 连接已保存的设备：附近的设备里搜到它在别的地址时，先连搜到的地址再连保存的地址；否则连保存的地址，同时按设备 ID 查找 5 秒，失败码为 `network-failure`、`timeout`、`session-mismatch` 时改连查到的地址。连上的不是保存的地址时提示“已找到新地址并连接”。
- 连着时：控制通道异常断开后每 2 秒重连，10 秒内没恢复就断开并向对方发告别请求；对方以 4001、4002 关闭时立即断开。对方的 `directory.list` 只能读本机游戏目录。本机游戏或关联变化、收到 `catalog.changed` 或控制通道重新打开时重新交换目录表；对方答复 `session-mismatch` 或 `permission-denied` 时断开。
- 互斥：本机连着别的设备（包括正在重连）时，本机监听服务对新的目录交换答复 `busy`，控制通道升级答复 403；有设备连进本机时不能拨号。
- 断开、忘记设备和退出应用时向对方发告别请求（`POST /v1/catalog`，正文 `{deviceId, goodbye: true}`），最多等 2 秒；对方收到后断开本机。本机服务停止时，连进本机的设备显示离线，本机连着的设备不受影响。
- 设备图标：按已保存设备记录的平台显示；附近的设备按 TXT 里的平台显示。

电脑只设置本机目录；移动端的目录由移动端设置后交换公开引用。断开只结束本次连接，移动端之后可以重新连接。设备断开/移除不删除存档；移除游戏或更换目录后，原目录不再作为该游戏的接收目标。

保存游戏配置会核对目录是否已在本机选择器中登记；传输进行中先结束任务，再修改游戏目录或关联。设备改名保留原项目关系，重启继续读取同一份配置；失效目录保留记录并提示重新选择。

## 3. 分发包与应用标识

打包命令见 `docs/development.md`。`pnpm desktop:package` 和 tag 发布流程只构建免安装版 `SavedataSync-<版本>-Portable-x64.exe`，产物在 `apps/desktop/release/`。

版本由 `scripts/app-version.mjs` 按 Git tag 推算。electron-builder 会去掉开发版的 `+<提交数>.g<哈希>` 部分：文件名和 exe 的文件版本只有 `0.3.0` 这样的数字版本，界面上显示完整版本。当前构建未签名。

打包脚本将已编译的 `out/` 和最小应用清单复制到 `.reports/` 下的新暂存目录，隔离工作区依赖；使用本机 Electron 分发文件，缺少时由打包器下载。免安装包及暂存资源不纳入 Git。

分发包不带 `node_modules`，主进程运行时用到的第三方包（`ws`、`@homebridge/ciao`、`bonjour-service`）列在 `electron.vite.config.ts` 的 `main.build.externalizeDeps.exclude` 里，由 electron-vite 打进 `out/main`。主进程新增运行时依赖时要加进这个列表，构建后 `out/main/index.js` 的外部导入应只剩 `electron` 和 Node 内置模块。`ws` 的可选原生依赖 bufferutil、utf-8-validate 没有安装，打包后 `ws` 使用纯 JS 实现。

公共原图为仓库根目录的 `assets/app-logo.png`（透明 PNG）。侧栏以 64×64 显示，HTML 图标和界面通过构建引用同一资源。`resources/app-icon.ico` 提供 Windows 多尺寸图标，`BrowserWindow` 通过 `?asset&asarUnpack` 引用；打包脚本将 ICO 复制到暂存项目并解包，窗口和 EXE 均使用它。`signExecutable: false` 保持不签名，同时保留写入图标及版本信息的资源编辑。

## 4. 系统明暗主题

桌面默认跟随 Windows 系统外观，也可以在设置中选择浅色或深色；选择保存在本机，重启后继续使用。主进程按偏好设置 `nativeTheme.themeSource`，Renderer 读取 `prefers-color-scheme` 并切换 antd 的 `defaultAlgorithm`/`darkAlgorithm`，组件卸载释放监听。页面初始底色及原生 `BrowserWindow.backgroundColor` 同步采用对应明暗底色；原生主题监听在窗口关闭时释放。主题使用共用色板与组件库语义色。

## 5. 目录适配器

`src/main/directory-adapter.ts` 提供本机目录登记、恢复、当前层元数据和原生只读文件流。

| 接口 | 输入/输出 | 生命周期与失败 |
| --- | --- | --- |
| createDirectoryAdapter(configPath) | 主进程控制的绝对配置路径，返回适配器 | 不存在时创建身份；损坏/未知 schema、无效文件或权限失败抛异常，不重置原配置 |
| adapter.deviceId | 返回安装内稳定设备 ID | 与 IP 无关，不从机器 MAC 生成 |
| adapter.registerDirectory(path) | 仅系统选择器/受信任本地调用传入绝对目录；返回 OperationResult&lt;DirectoryReference&gt; | 配置保存后才更新内存；再次明确选择同一路径保留 rootId，重新核实身份并清除该根的旧条目引用 |
| adapter.listRoots() | 返回公开根引用列表 | 重查根身份；失效根标 unavailable，并保留配置 |
| adapter.listDirectory(rootId, parentId=null) | 当前层 DirectoryListing | 根层 parentId=null；子层必须使用已采集目录的 entryId。只读当前层，不汇总目录大小；不支持的链接/类型及读取失败返回错误 |
| adapter.openFile(reference) | 本进程有效的 EntryReference，返回 metadata、Node Readable 和 verifyUnchanged() | 调用者消费/关闭流后调用检查点，重查原身份、大小、mtime/ctime；不重新读内容。中途同大小改写可能漏过；流自动关闭句柄 |
| adapter.assertCacheIsolated(path) | 仅主进程传入缓存绝对路径 | 拒绝缓存与任何已登记根互相包含；只做隔离检查，不创建目录，也不向 IPC 暴露路径 |

除初始化工厂外，异步操作失败均返回稳定错误包络；内部 `DirectoryAccessError` 保留 cause，IPC 只输出脱敏后的 code/message/canRetry，不包含主机路径、堆栈或文件内容。

## 6. 有限 IPC 与服务控制

preload 通过 `window.desktopDirectories` 暴露冻结的 `DesktopDirectoryApi`：`chooseDirectory()`（取消返回 cancelled 并保留既有根）、`listRoots()`、`listDirectory(rootId, parentId?)`（仅接受不透明 ID）。固定通道为 directories:choose、directories:roots、directories:list。主进程检查窗口登记、主 frame 身份及精确 renderer URL；选择器返回后再次核实来源。子 frame、导航后的页面、额外参数、非法 ID 和附加路径字段均被拒绝。preload 另检查输入和响应结构，异常映射为脱敏错误；不暴露 ipcRenderer、通用 invoke、Node 句柄或文件字节。应用退出时移除 handler，窗口关闭时删除可信窗口记录；应用采用单实例锁。

拨号由 `window.desktopDialer` 的冻结 `DesktopDialerApi` 提供：`status()`、`watchNearby()`（同时续期局域网搜索）、`connect(addresses, expectedDeviceId)`（最多 16 个地址）、`connectSaved(deviceId)`；断开和忘记设备仍用 `desktopLibrary`。固定通道与响应守卫在 `src/bridge/dialer-bridge.ts`，主进程来源和参数校验在 `src/main/dialer-ipc.ts`。界面只在设备页用 `watchNearby` 轮询，其他页面用 `status`。

服务控制由 `window.desktopService` 的冻结 `DesktopServiceApi` 提供：`status()`、`start(port)`、`randomizePort()`、`stop()`、`chooseTarget()`，以及第 8 节的扫描方法。固定通道与响应守卫在 `src/bridge/service-bridge.ts`，主进程来源/参数校验在 `src/main/service-ipc.ts`。

- `start` 接受 1 到 65535 的整数，本机显式启动后监听 `0.0.0.0`，冲突返回错误。端口保存到应用私有目录，首次生成 49152 到 65535 的随机值；`randomizePort()` 选择并保存另一个端口。
- 快照含设备 ID、本机设备名、配置端口、实际监听地址与开始监听的时间（Unix 毫秒）、本机 IPv4 地址、运行错误和局域网广播状态；没有 sessionId、私有路径或文件内容。
- 本机 IPv4 由 `recommended-address.ts` 推荐：用 `route print -4` 查默认路由和 metric，用 `reg query` 查网卡驱动是否标记为物理网卡（NCF_PHYSICAL），按 IP 和 `os.networkInterfaces()` 对应，不启动 PowerShell，通常 0.2–0.3 秒。先取物理网卡且有默认网关的地址，没有时取任意有默认网关的地址，再加 Windows 移动热点 192.168.137.1；排除代理软件常用的 198.18.0.0/15，一个都没有时退回全部可用地址；按推荐顺序、去重，最多 8 个。服务每次启动后在后台重新读取，读到之前为 `null`，设备页显示读取中；之后缓存 30 秒并在后台刷新；查询失败时为空数组。
- 设备页用设备 ID、实际端口和这组地址生成连接二维码，第一个地址作为显示和复制的地址。已保存的设备按最近连接排序：`library-store.ts` 在每次新连接（目录请求带 `x-sync-connect: 1`）时把该设备移到开头，连接期间的目录刷新不改顺序。
- 设备页的本机服务卡片用 shared/ui `ServiceHero` 的常规排版，运行信息只有运行时长和局域网广播状态，连着哪台设备看下方设备列表里设备图标的绿点。已保存的设备行只显示名称和地址，状态只靠图标颜色表示：灰色是离线，蓝色是在线（附近搜到或已连接），已连接再在右下角加绿点；附近搜到时地址换成搜到的地址。服务停止时显示端口输入框和换随机端口的图标按钮（shared/ui `ShuffleIcon`，悬停提示“随机生成”）；窗口窄到一行放不下时，输入框和按钮一起换到标签下一行。设备列表的行不能点，不加悬停反馈。
- `chooseTarget()` 打开原生系统选择器，选中后登记为本机目录并返回 `DirectorySelectionResult`，取消返回 cancelled。全部 Promise 将失败转为脱敏错误。界面每秒读取状态，卸载停止轮询。

服务开始监听后，`src/main/discovery-advertiser.ts` 用 `@homebridge/ciao` 在局域网广播 `_savedata-sync._tcp`（格式见[共享包](shared-package.md#9-发现与连接二维码)）：实例名取本机名称，SRV 主机名由设备 ID 生成，只发 IPv4，每块网卡只回答这块网卡的地址；网卡增减或地址变化后 ciao 每 15 秒检查一次并重新宣告。停止服务和退出应用时发送 goodbye 包并关闭 UDP 5353 套接字，最多等 3 秒。广播失败不影响 HTTP 服务，快照的 `discovery.status` 为 `failed`，每 30 秒重试。`advertising` 只表示本机已发出宣告，防火墙拦截 UDP 5353 时其他设备仍然搜不到。

`src/main/discovery-browser.ts` 用 `bonjour-service` 搜索 `_savedata-sync._tcp`，和 ciao 广播在同一进程里同时使用 UDP 5353。搜索在续期后进行，停止续期 10 秒后停止并关闭套接字；按设备 ID 查找期间也保持搜索。mDNS 应答方只在被问到或上线时宣告，所以搜索期间每 4 秒重新查询。搜到的服务要请求 `/v1/device` 得到 200 才出现在结果里，每次重新查询时一并重新探测，已出现的服务连续 2 次失败后去掉；离开的设备不一定发出 goodbye 包，原因见 [Android 平台层](android.md#12-局域网设备搜索)。结果排除本机设备 ID，同一设备 ID 只保留一项；TXT 协议版本不同的设备只列出实例名，界面显示为版本不同。无法开始搜索时状态为 `failed`，下次续期再试。

## 7. 配置与路径边界

应用在 `app.getPath('userData')/directory-config.json` 保存 schemaVersion=1、deviceId 与 roots。内部根记录仅含 rootId、规范路径和 bigint dev/ino 的字符串身份；绝对路径不传到 Renderer，也不写进项目记忆。条目 ID/相对路径映射只在本进程内有效，不保存历史元数据或哈希，重启后重新枚举。

应用启动先创建并解析系统提供的 userData 实际位置，再初始化配置和私有缓存，以兼容系统目录重定向。

配置写入使用同目录独占临时文件、sync 和 rename；同进程登记串行处理，成功前不更新内存。配置必须位于所选根目录之外；目录损坏或版本未知时停止初始化。跨外部进程的配置事务或锁不在当前实现内。

每次读取重新检查根身份；路径逐段 lstat，拒绝 symlink/junction，核对 realpath 与根范围，读取句柄再核对身份。文件/目录替换使旧引用失效，需要刷新或明确重新选择。不跟随根内链接；不支持的条目会让该层读取返回错误，不显示成空目录。

Node 的路径检查与文件打开是两个操作。本实现检查可观察到的替换和越界；外部进程恶意并发重排命名空间时不提供内核级隔离，也不提供目录级原子替换。

## 8. 当前扫描

`WindowsSyncScanner` 构造时传入本机目录适配器，`start(rootId)` 返回扫描句柄（最多保留 32 份结果，满时丢掉最旧的），`get(scanId)` 查询，`cancel(scanId)` 显式取消，退出时 `await stop()` 等待关流。原生验证可收紧 maxEntries/timeoutMs/retentionMs，不能放宽固定预算；失败使用脱敏 OperationError，结果只存当前会话。

HTTP 服务注入 `scanSource: adapter` 后开放 `/v1/sync/capabilities`、`POST /v1/sync/scans` 和 `GET/DELETE /v1/sync/scans/{scanId}`。请求遵守会话头及严格 JSON，登记只接收 `{ schemaVersion: 1, rootId }`，202 后查询实际结果。注入 `sync` 编排后声明复制/备份为 supported；远端恢复为 unsupported，本机恢复通过独立本地桥执行。

有限 `desktopService.startScan(rootId)`、`queryScan(scanId)`、`cancelScan(scanId)` 返回 `OperationResult<SyncScanState>`，桥会核对请求引用与返回句柄。扫描复用原生只读流，前后重查文件/目录变化，空目录单独表示，目录大小恒为 null；完成结果保留最多 10 分钟，停止/重启服务使旧句柄失效。

## 9. 私有归档

`src/main/archive-adapter.ts` 仅供主进程调用，使用内置 fs/stream/zlib。文件、缓存和流留在原生层，归档对象和文件内容不跨 preload/JS 桥。

| 接口 | 输入/输出 | 所有权与失败 |
| --- | --- | --- |
| createWindowsArchiveAdapter(source, privateDirectory, options?) | 目录读取适配器与既有应用私有绝对目录 | 缓存固定放 transfer-archives-v1 子目录，不能与任何已登记源根重叠；启动只清理验证过的孤儿缓存；失败抛脱敏 ArchiveError |
| archive.checkStagingSpace(bytes) | 解包原文字节数，返回缓存所在卷和需要的字节数 | 超过缓存预算报 resource-limit，空间不足报 insufficient-space |
| archive.sendFiles(rootId, files, destination, options?) | 复制计划的文件列表（fileId、entryId、大小、修改日期）和可写流 | 按顺序边读边打包 gzip1 写入 destination，写完结束它；文件的大小或修改日期与计划不同、读取期间被改动时抛 source-changed |
| archive.receiveFiles(files, input, options?) | 计划的文件列表和原始 Node Readable，返回 WindowsStagedFiles | 从调用起接管并最终关闭 input；按计划逐成员核对并通过 gzip 校验后才返回；失败或取消时清理本次缓存 |
| staged.openFile(fileId) / dispose() | 只读流；fileId 必须属于本次内容 | 调用者必须消费或 destroy；dispose 后所有方法失效 |
| archive.retryCleanup() | 重试本缓存根的失败清理 | 不删除仍在使用的文件；清理成功后才释放进程互斥 |

操作 options 可传 signal 和 onBytes（累计已打包或已解包的文件内容字节数）。普通 abort 抛 ArchiveCancelledError，TimeoutError signal 映射 timeout；清理也失败时原错误保留，独立 cleanupError=cleanup-failed。

默认执行共享包的每文件/总原文/tar 上限、64 KiB 显式 IO 缓冲及 3 GiB 私有缓存预算。options.quota 可以进一步收紧本机预算；options.io 仅供受信任主进程注入磁盘空间检查和删除能力。满额 1 GiB 双向传输和进程内存实测见[验收标准](../testing/acceptance.md)。

解包只写到随机任务目录。根/任务都有所有权标记并检查目录身份，进程内一份活动缓存。清理先核实所有成员，再逐个 unlink 普通文件并 rmdir 空任务目录；拒绝陌生文件、子目录、链接和多重硬链接。

归档严格按[设备接口与归档格式](transfer-protocol.md#3-归档格式)的规范化 USTAR 头、顺序 fileId、零填充和两个结束块生成/校验。`archive-format.ts` 的 `createStrictGunzip` 自己解析 gzip 头尾：要求固定头和单 member，用原始 DEFLATE 解码并核对它实际消耗的字节数、CRC32/ISIZE；拒绝拼接、尾随、损坏、截断、链接及扩展头。`test/fixtures/archive-v1.json` 由 Python 标准库独立生成，Node 和 Java 测试共用。

## 10. HTTP 服务与任务生命周期

`src/main/http-service.ts` 的 `WindowsHttpService` 构造时不监听网络。应用初始化目录/归档/服务对象，用户点服务按钮后通过有限 IPC 启动，监听失败（端口被占用或在系统保留的端口段里）报 `port-unavailable`，退出时等待 stop。原生 API 缺省回环地址和动态端口；自动化 HTTP 检查使用 127.0.0.1。

| 原生 API | 输入/返回 | 责任 |
| --- | --- | --- |
| new WindowsHttpService(source, options?) | 目录读取适配器；可选 library、displayName、scanSource、sync（写入器、备份、归档）和仅收紧的 `BATCH_TIMEOUTS_MS` 期限 | 注入 scanSource 和 sync 后开放扫描与复制任务 |
| service.start({host?, port?}) | 返回实际 host/port/sessionId/startedAt | 端口冲突明确失败，不换端口重试；每次重新启动生成会话 |
| service.getAddress() / getError() | 监听快照或 null；脱敏运行时错误或 null | sessionId 只用于识别服务重启，认证不在这层 |
| service.stop() | Promise&lt;void&gt; | 关闭连接，取消并等待任务和缓存清理；并发调用共用同一个 Promise；清理失败时端口已关闭，可以再次 stop |

路由和包络见[设备接口与归档格式](transfer-protocol.md#4-http-路由与会话)。除了 device 均核对唯一会话头。JSON 严格 UTF-8、无 BOM/重复解码键、深度不超过 128，按实际 UTF-8 字节执行 8 MiB 请求及响应预算；拒绝编码体、trailer、重复头、歧义 CL/TE、非法/重复查询、错误方法和 Range。请求/响应无进展 60 秒、整个 HTTP 请求 30 分钟、请求头 15 秒及 16 KiB 头预算。

复制任务由 `WindowsSyncRegistry` 登记，期限、留存和结果见[复制、备份与恢复约定](sync-copy.md)。失败、取消和超时等待实际 IO 结束再清理；清理失败保留互斥，明确重试成功后才释放。主进程 before-quit 等待 HTTP 服务停止；清理失败显示错误并保留重试机会。

## 11. 写入候选残留

写入候选只在当前进程内有所有权。崩溃或强制退出可能在目标目录留下 `.savedata-copy-<UUID>.tmp`、`.savedata-new-<UUID>.tmp` 候选；复制写入时 `WindowsSyncWriter` 开始写目标目录前删除其中的候选文件，扫描也跳过它们（[接口约定](api-contracts.md)第 3 节）。真实断电及其他文件系统还没验证。

## 12. 独立备份与恢复材料

`createWindowsBackupStore(adapter, privateDirectory, gameName)` 在 `userData/backups/` 初始化独立备份，结构和移动端相同：`<游戏名>/<UTC 时间>/` 内含 `backup.json` 和按原路径保存的 `files/`。`gameName` 只决定新备份的文件夹名，备份归属看 `backup.json` 里的 ID。启动时登记备份区，目录适配器拒绝把它及其父子目录选作同步根。用户可以随时删改这个文件夹，所以每次按实际目录读取；整个文件夹被删后自动重建，设置在 `userData/backup-settings.json`。备份不进入同步比较，清除应用数据会丢失备份。

| 原生方法 | 输入、输出和资源责任 |
| --- | --- |
| `settings()` / `setPreference(projectId, policy)` | 独立 `SyncBackupSettings`；缺少设置项时开启，坏设置拒绝修改并保留原文件 |
| `create(plan, options?)` | 接受有效、可执行且目标设备匹配的 `SyncPlan`，写入前保存目标目录的全部文件；返回 `{ manifest, cleanupError }`，关闭备份、没有写入或目标没有文件时 manifest 为 null |
| `createManual(projectId, snapshot, options?)` | 从本机扫描快照立即创建 `reason = 'manual'` 备份；空目录返回 `{ manifest: null, cleanupError: null }` 不建空轮次，提交后按保留份数平级轮换 |
| `capacity(requiredBytes)` | 预检私有卷剩余空间；可得量未知为 null，不足抛 insufficient-space；不提前删除有效旧轮次换空间 |
| `list(projectId)` | 返回这个游戏的已提交清单和未完成轮次 ID，包括游戏之前用过的目录的备份；恢复必须 acquire |
| `acquire(projectId, backupId, options?)` | 完整核对每个原文文件后返回原生句柄；`snapshot()` 为本次恢复建立临时树，`openFile(fileId)` 返回只读 stream 与 verifyUnchanged；消费者关闭读流后 release |
| `rotate(projectId)` / `cleanupIncomplete(projectId, backupId)` | 显式重试轮换或清理未提交、文件缺失或大小不符的轮次；有效备份和正在被恢复引用的轮次不通过这个入口删除 |
| `deleteBackup(projectId, backupId)` | 用户确认后删除一份备份；先撤下清单，中途失败时变成可清理的残留；正在被恢复引用时拒绝 |
| `deleteGameBackups(projectId)` | 移除游戏时删除它在所有目录下的备份、残留和单独设置；失败时游戏保留，可以重试 |
| `stop()` | 应用退出时取消正在创建/校验的备份并等待资源释放 |

创建时清单先写成 `in-progress.json`，每个文件复制前后核对来源的大小和修改日期、核对复制的字节数，复制出的文件带上来源的修改日期；全部完成后原子改名为 `backup.json`。默认期限 30 分钟；不超过 16 MiB 的文件整个读入后写出，更大的按 1 MiB 分块。预算、清单和恢复规则见[复制、备份与恢复约定](sync-copy.md)。

每个游戏保留的份数取备份设置（1–4096，默认 3），不分目录，只统计完整的备份；自动备份（`copy`、`restore`）与手动备份（`manual`）平级轮换。新轮可读后才轮换；活动恢复句柄保护输入轮次。淘汰先把 `backup.json` 改回 `in-progress.json` 再删文件。文件缺失或大小不符的备份和未提交的一样显示为不完整，不能恢复，不挡新备份，须明确清理；读不懂的内容直接忽略，不自动删除。

`src/main/manual-backup-registry.ts` 的 `WindowsManualBackupRegistry` 持有本机手动备份异步任务：启动时复核本机游戏目录并占用 `TargetOperation` 名额，扫描当前存档目录并调用 `createManual` 提交，终态按 `BATCH_TIMEOUTS_MS.terminalRetention` 保留供查询，应用退出时随 `stop()` 取消并释放名额。

有限 `window.desktopBackups` 只提供 read/list/manifest/setPreference/setDefaults/rotate/cleanupIncomplete/deleteBackup/deleteGameBackups/openFolder 及手动备份接口 startManual/currentManual/manualState/cancelManual，输入仅为项目、任务、轮次 ID、保留份数和布尔开关。read 的 displayPath 仅供位置展示；列表使用摘要，单轮详情才返回完整清单。

## 13. 受保护目标写入与本机恢复

`WindowsSyncWriter(adapter, backups, options)` 执行完整确认计划。`WindowsSyncRegistry` 接入 Android → Windows 的 HTTP 接收、缓存和实际结果查询，以及 Windows → Android 的原生源准备和单次下载。源端 POST 接纳后异步重新扫描并核对当前源、形成不可变归档；准备完成且扫描资源释放后才发布 ready。GET 内容只领取一次；无文件的源计划直接报告发送完成。协议见[复制、备份与恢复约定](sync-copy.md#6-http-与本地桥)。

| 原生方法 | 输入、输出与资源责任 |
| --- | --- |
| `apply(plan, material, options?)` | 计划须可执行、目标为本机、方向为 dialer-to-listener 或 local-restore；非法/过期/重复确认或 busy 抛错误；已接纳任务返回完整 `SyncApplyResult` |
| `prepareRestore(projectId, rootId, backupId, targetSnapshot)` | 完整验证并引用备份，生成强制保护当前内容的恢复计划；返回 `{ plan, apply, close }`，已使用/释放的预览不能再执行 |
| `retryCleanup()` | 只清理本进程仍持有、身份匹配的候选 |
| `checkSpace(plan, privateSpace?)` | 合计新文件、完整备份和同卷接收缓存的余量 |
| `stop()` | 停止接纳并取消当前任务；应用先停止目标任务，再关闭备份存储 |

本机快照和恢复预览有效期 10 分钟；远端快照由所属会话核实。已接纳任务总期限 30 分钟。执行前重新扫描全部目标并核对原始条目 ID、路径、类型、大小和修改日期。备份开启时，先为目标目录的全部文件提交有效备份，再创建目录、逐文件写入；本机恢复始终先备份。

`sync-target-files.ts`：同卷独占候选、原生流写入并核对字节数，写完把修改日期设为来源的；新建使用无覆盖 link，替换在重查父目录、旧文件身份/大小/日期及候选身份后 rename。目录按父子顺序逐个创建。计划要求删除时排在所有写入之后，由深到浅逐项删除，文件先核对身份、大小和修改日期，文件夹用非递归 `rmdir`，只删空的。

第一次失败/取消/未知后，后续项记为 not-attempted；已经确认成功的内容保留。候选清理失败独立报告，保留任务名额直到明确清理成功。`target-operation.ts` 与旧批次共用进程互斥。

第一次写目标前，`InterruptedWriteStore` 在 `userData/interrupted-writes/<planId>.json` 落盘标记（写不了就报错，目标不变），结束时删除。不在本进程活动集合里的标记说明上个进程写到一半被结束：`desktopSync.interruptedWrites()` 读取，`dismissInterruptedWrite(id)` 一次性清除，界面据此提示一次，已移除游戏的标记直接清掉。

## 14. 同步结果与本机恢复界面

游戏操作菜单的“任务与结果”展示本进程内的复制和恢复任务，计划、来源/目标、备份状态、阶段和逐项实际结果分别显示。电脑发送完成时提示“文件已发送。请在移动端查看写入结果。”；电脑接收才显示本机写入结果。

“备份与恢复”按游戏读取完整备份与未完成轮次。写入前自动备份默认关闭，开关不弹确认，关闭时备份设置仍显示保留份数（1–4096）。页面提供“立即备份”按钮，点击直接启动本机手动备份（不弹确认、不填备注），显示实时进度与取消按钮，完成后刷新列表并自动选中新备份；空目录时提示当前目录没有文件可备份。本机恢复先读取并验证所选备份、扫描当前目录，生成固定预览，用户确认后由主进程执行。恢复前始终备份当前目录的全部文件，目标独有文件保留，恢复总是写进游戏当前的目录。

`src/main/restore-registry.ts` 的 `WindowsRestoreRegistry` 持有恢复任务。关闭详情、切页或刷新 Renderer 只停止页面轮询；本进程中的任务、预览及实际结果仍可按 ID 查询。网络服务停止不取消本机恢复；应用退出先停止网络编排和恢复，再停止写入器与备份。

冻结的 `window.desktopSync` API 返回 `Promise<OperationResult<T>>`：

| 方法 | 输入与结果 |
| --- | --- |
| `activity()` | 返回进程内目标操作或清理占用状态，用于配置编辑保护 |
| `copies()` | 最多 32 份 `DesktopCopySummary`；`isAwaitingPeer` 只在已确认、移动端还没登记任务时为 true，此时 phase 必为 running；`isPeerInitiated` 为 true 表示任务由对方设备发起：监听方任务看登记时是否匹配本机已确认、等对方登记的请求，拨号方任务看是否来自监听方的 `sync.prepare` |
| `copyPlan(jobId)` / `copyState(jobId)` | 分别返回 `SyncJobRequest` 和含本机、对端两个角色的 `SyncTransferState` |
| `cancelCopy(jobId)` / `cleanupCopy(jobId)` | 取消先通知移动端再停止本机；清理成功返回 null |
| `restores()` | 最多 32 份 `DesktopRestoreSummary`，含状态、阶段、清理标记和 `isWorking` |
| `prepareRestore(projectId, rootId, backupId)` | rootId 是游戏当前的目录，备份可以来自游戏之前用过的目录；返回 preparing 状态 |
| `restorePlan(restoreId)` / `restoreState(restoreId)` | 分别返回固定 `SyncPlan` 和 `DesktopRestoreState` |
| `executeRestore(restoreId, plan)` | 完整且与原生预览一致的可执行计划；接纳后立即返回 running 状态 |
| `cancelRestore(restoreId)` | 取消准备/未确认预览或请求停止写入 |
| `cleanupRestore(restoreId)` / `releaseRestore(restoreId)` | 前者重试释放本次候选/输入，后者释放已停止的预览/结果 |

`isWorking` 表示原生 worker 尚未退出。本机预览和已结束结果保留最多 10 分钟，查询不延长；本进程最多接受 4096 次恢复确认。准备和执行各受 30 分钟总期限限制。进程重启后只保留配置和已提交备份，任务 ID 不恢复。所选备份已被轮换淘汰时，重新预览返回 not-found。

固定 `sync:*` 通道在 `src/bridge/sync-bridge.ts` 登记，`sync-ipc.ts` 核对受信任窗口、主 frame、精确 URL、封闭参数和 8 MiB 控制响应预算。非法输入/计划为 invalid-request，名额占用为 busy，已消费确认是 task-conflict，过期或已释放为 not-found；错误不授权自动重放。

## 15. 测试范围

`apps/desktop/test/` 覆盖目录/IPC、归档、HTTP 服务、扫描、备份和受保护写入的最小长期回归，由 `pnpm test` 运行。测试只覆盖公开接口、数据关系、文件安全和关键传输结果；界面、日志文本和内部调用顺序不进入长期测试。临时夹具基于 realpath 的系统临时根。

Windows 短路径检查通过 PowerShell 调用 GetShortPathName 生成真实 8.3 别名，并在只影响子进程的 TEMP/TMP 环境中重跑目录与 IPC 用例；卷未生成不同短名时跳过这一项。HTTP 测试使用真实回环 HTTP/TCP，时间边界由注入的时钟和仅收紧的期限验证，不等待实际 30 分钟。

实际桌面窗口、系统选择器、Android LAN 双向、取消、清理重试和界面结果已在真机上验收，见[验收标准](../testing/acceptance.md)。电脑拨号没有长期测试，连接和传输的验收结论见[验收标准](../testing/acceptance.md)第 3 节。
