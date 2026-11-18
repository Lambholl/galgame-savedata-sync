---
doc_type: architecture
status: active
updated: 2026-11-19
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
- [11. 旧 v1 新文件发布与接收](#11-旧-v1-新文件发布与接收)
- [12. 独立备份与恢复材料](#12-独立备份与恢复材料)
- [13. 受保护目标写入与本机恢复](#13-受保护目标写入与本机恢复)
- [14. 同步结果与本机恢复界面](#14-同步结果与本机恢复界面)
- [15. 测试范围](#15-测试范围)

## 1. 范围与入口

代码在 `apps/desktop`。目录读取模块保持源只读；私有归档负责快照、编解码和缓存清理；HTTP 服务负责设备/目录查询、双向传输及状态/取消。桌面提供服务启停、实际地址/端口、目录选择、任务计划与实际结果、备份设置和本机恢复。

电脑目前只作监听方：提供 HTTP 服务和控制通道，接纳拨号方登记的任务；电脑发起的复制经控制通道交给拨号方，对方须开着应用并保持连接，计划在电脑确认、拨号方执行。M-005 增加电脑作拨号方：主进程编排扫描、计划和任务，用 `node:http` 和 `ws` 连接对方，用 `bonjour-service` 搜索局域网设备（[ADR-0004](../decisions/ADR-0004-symmetric-listener-dialer-roles.md)）。旧 v1 批量接口只新建文件，新复制协议按确认计划执行新增、受保护覆盖、跳过和删除多余项。

Electron 构建显式内联 workspace 共享包，避免 sandbox preload 在运行时 require TypeScript 源码。preload 保留 CJS 输出，contextIsolation/sandbox 开启，Renderer 无 Node 集成。

## 2. 游戏与设备界面

桌面界面位于 `src/renderer/src/app` 和 `features`，通过 `src/renderer/src/platform/library-adapter.ts` 接入有限 IPC；业务规则从 `apps/shared` 导入。主导航为设备、游戏和设置；游戏操作面板提供目录设置、传输页与任务入口。目录设置用可换行文本显示完整路径，旁边有选择目录按钮；地址用只读 Input 配复制按钮。文件列表始终左右并列，显示分钟级修改时间，文件夹大小显示“—”，未知文件属性显示“未知”。

- 新增设备默认使用对端设备名称。电脑报告系统计算机名称；Android 优先报告系统设备名称，取不到时使用型号。重新连接保留已经保存的自定义名称。
- 左键单击或右键单击游戏卡片，都打开该游戏的操作菜单。
- 游戏卡片和移动端一致：三组渐变、居中封面、底部名称/设备数量和箭头。桌面卡片宽 160–180px，封面至少高 152px、信息区至少高 88px，保持竖版；长标题换行，颜色跟随明暗主题。
- 添加游戏会打开弹窗，点击“选择存档目录”直接选择文件夹，随后显示游戏名输入框，默认填入父目录名，可以修改后确认添加；取消不会创建游戏。从对端导入游戏时也先选择本机目录。选择目录即同意在该目录接收文件，重启后沿用配置，接收前会重新检查目录身份和写权限。

游戏与设备配置保存在应用私有目录的 `game-library.json`。一个游戏保存本机一个目录，关联多个对端游戏；同一时间只接纳一台在线移动端。移动端通过 `POST /v1/catalog` 提交自己的目录表并取回电脑目录表。在线状态看 WebSocket 控制通道（`control-hub.ts`）：控制请求 8 秒内要应答，15 秒心跳没有回应按断开处理（`CONTROL_LIMITS`）。运行传输时保留单活动批次限制。

电脑只设置本机目录；移动端的目录由移动端设置后交换公开引用。断开只结束本次连接，移动端之后可以重新连接。设备断开/移除不删除存档；移除游戏或更换目录后，原目录不再作为该游戏的接收目标。

保存游戏配置会核对目录是否已在本机选择器中登记；传输进行中先结束任务，再修改游戏目录或关联。设备改名保留原项目关系，重启继续读取同一份配置；失效目录保留记录并提示重新选择。

## 3. 分发包与应用标识

打包命令见 `docs/development.md`。产物在 `apps/desktop/release/`：

- `SavedataSync-<版本>-Setup-x64.exe`：安装版，可选择安装目录，安装结束后手动启动。
- `SavedataSync-<版本>-Portable-x64.exe`：免安装版。tag 发布流程只构建这一种。

版本由 `scripts/app-version.mjs` 按 Git tag 推算。electron-builder 会去掉开发版的 `+<提交数>.g<哈希>` 部分：文件名和 exe 的文件版本只有 `0.3.0` 这样的数字版本，界面上显示完整版本。当前构建未签名。卸载保留应用配置。

打包脚本将已编译的 `out/` 和最小应用清单复制到 `.reports/` 下的新暂存目录，隔离工作区依赖；使用本机 Electron 分发文件，缺少时由打包器下载。安装包、免安装包及暂存资源不纳入 Git。

分发包不带 `node_modules`，主进程运行时用到的第三方包（`ws`、`@homebridge/ciao`）列在 `electron.vite.config.ts` 的 `main.build.externalizeDeps.exclude` 里，由 electron-vite 打进 `out/main`。主进程新增运行时依赖时要加进这个列表，构建后 `out/main/index.js` 的外部导入应只剩 `electron` 和 Node 内置模块。`ws` 的可选原生依赖 bufferutil、utf-8-validate 没有安装，打包后 `ws` 使用纯 JS 实现。

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

服务控制由 `window.desktopService` 的冻结 `DesktopServiceApi` 提供：`status()`、`start(port)`、`randomizePort()`、`stop()`、`chooseTarget()`、`revokeTarget(rootId)`、`cancel(transferId)`、`retryCleanup()`。固定通道与响应守卫在 `src/bridge/service-bridge.ts`，主进程来源/参数校验在 `src/main/service-ipc.ts`。

- `start` 接受 1 到 65535 的整数，本机显式启动后监听 `0.0.0.0`，冲突返回错误。端口保存到应用私有目录，首次生成 49152 到 65535 的随机值；`randomizePort()` 选择并保存另一个端口。
- 快照含设备 ID、配置端口、实际监听地址与开始监听的时间（Unix 毫秒）、本机 IPv4 地址、运行错误、局域网广播状态、本进程接收根和当前会话任务；没有 sessionId、私有路径或文件内容。
- 本机 IPv4 由 `recommended-address.ts` 推荐：用 `route print -4` 查默认路由和 metric，用 `reg query` 查网卡驱动是否标记为物理网卡（NCF_PHYSICAL），按 IP 和 `os.networkInterfaces()` 对应，不启动 PowerShell，通常 0.2–0.3 秒。先取物理网卡且有默认网关的地址，没有时取任意有默认网关的地址，再加 Windows 移动热点 192.168.137.1；排除代理软件常用的 198.18.0.0/15，一个都没有时退回全部可用地址；按推荐顺序、去重，最多 8 个。服务每次启动后在后台重新读取，读到之前为 `null`，设备页显示读取中；之后缓存 30 秒并在后台刷新；查询失败时为空数组。
- 设备页用设备 ID、实际端口和这组地址生成连接二维码，第一个地址作为显示和复制的地址。已保存的设备按最近连接排序：`library-store.ts` 在每次新连接（目录请求带 `x-sync-connect: 1`）时把该设备移到开头，连接期间的目录刷新不改顺序。
- `chooseTarget()` 打开原生系统选择器；选中目录后执行 `publisher.grant`，取消保留既有授权。`revokeTarget` 撤销新写入授权并收尾该根的当前发布。全部 Promise 将失败转为脱敏错误。界面每秒读取状态，卸载停止轮询。`cancel()` 保留已经发布的文件。

服务开始监听后，`src/main/discovery-advertiser.ts` 用 `@homebridge/ciao` 在局域网广播 `_savedata-sync._tcp`（格式见[共享包](shared-package.md#9-发现与连接二维码)）：实例名取本机名称，SRV 主机名由设备 ID 生成，只发 IPv4，每块网卡只回答这块网卡的地址；网卡增减或地址变化后 ciao 每 15 秒检查一次并重新宣告。停止服务和退出应用时发送 goodbye 包并关闭 UDP 5353 套接字，最多等 3 秒。广播失败不影响 HTTP 服务，快照的 `discovery.status` 为 `failed`，每 30 秒重试。`advertising` 只表示本机已发出宣告，防火墙拦截 UDP 5353 时其他设备仍然搜不到。

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

`src/main/archive-adapter.ts` 仅供主进程调用，使用内置 fs/stream/zlib/crypto。文件、缓存和流留在原生层，归档对象和文件内容不跨 preload/JS 桥。

| 接口 | 输入/输出 | 所有权与失败 |
| --- | --- | --- |
| createWindowsArchiveAdapter(source, privateDirectory, options?) | 目录读取适配器与既有应用私有绝对目录 | 缓存固定放 transfer-archives-v1 子目录，不能与任何已登记源根重叠；启动只清理验证过的孤儿缓存；失败抛脱敏 ArchiveError |
| archive.prepare(request, options?) | DownloadBatchRequest，返回 WindowsArchive | 按流复制源至私有快照，实测长度/SHA-256 并核实读取后元数据，再打包 gzip1；成功后调用者持有缓存，必须 dispose |
| archive.receive(manifest, input, options?) | BatchManifest 和原始 Node Readable | 从调用起接管并最终关闭 input；完整保存/校验压缩体及全部原文后才返回句柄 |
| artifact.manifest | 冻结的本次清单、实际长度/哈希 | 当前任务专用，不持久化为历史基线 |
| artifact.openArchive() / openFile(fileId) | 只读流；fileId 必须属于本清单 | 调用者必须消费或 destroy；未关闭读流会使 dispose 报 busy；不返回缓存路径 |
| artifact.dispose() | Promise&lt;void&gt; | 幂等并合并并发清理；失败保留互斥，禁止新任务，允许再次 dispose 或 retryCleanup |
| archive.retryCleanup() | 重试本缓存根的失败清理 | 不删除其他缓存根或仍在操作/仍有读流的任务；清理成功后才释放进程互斥 |

操作 options 可传 signal 和 onProgress。普通 abort 抛 ArchiveCancelledError，TimeoutError signal 映射 timeout；清理也失败时原错误保留，独立 cleanupError=cleanup-failed。进度快照分开源读取、压缩体已暂存、原文校验字节与已校验文件数；只有文件结果表示最终发布。

默认执行共享包的每文件/总原文/tar/压缩体上限、64 KiB 显式 IO 缓冲及 3 GiB 私有缓存预算。options.quota 可以进一步收紧本机预算；options.io 仅供受信任主进程注入磁盘空间检查和删除能力。接收登记前检查压缩体、解包原文和整批目标文件的可用空间，缓存与目标同卷时合计峰值，不足返回 `insufficient-space`。满额 1 GiB 双向传输和进程内存实测见[验收标准](../testing/acceptance.md)。

源快照和解包只写到随机任务目录。根/任务都有所有权标记并检查目录身份，进程内一份活动缓存。清理先核实所有成员，再逐个 unlink 普通文件并 rmdir 空任务目录；拒绝陌生文件、子目录、链接和多重硬链接。

归档严格按[传输协议](transfer-protocol.md)的规范化 USTAR 头、顺序 fileId、零填充和两个结束块生成/校验。gzip 限制固定头和单 member，使用原始 DEFLATE 解码并核对实际消耗字节、CRC32/ISIZE、完整 tar 长度及每文件 SHA-256；拒绝拼接、尾随、损坏、截断、链接及扩展头。`test/fixtures/archive-v1.json` 由 Python 标准库独立生成，Node 和 Java 测试共用。

## 10. HTTP 服务与任务生命周期

`src/main/http-service.ts` 的 `WindowsHttpService` 构造时不监听网络。应用初始化目录/归档/服务对象，用户点服务按钮后通过有限 IPC 启动，退出时等待 stop。原生 API 缺省回环地址和动态端口；自动化 HTTP 检查使用 127.0.0.1。

| 原生 API | 输入/返回 | 责任 |
| --- | --- | --- |
| new WindowsHttpService(source, archive, options?) | 目录读取/归档适配器；可选 publisher、displayName、时钟、仅收紧的期限/会话容量 | 同时有 publisher 及 archive.receive 才启用旧 v1 上传 |
| service.start({host?, port?}) | 返回实际 host/port/sessionId | 端口冲突明确失败，不换端口重试；每次重新启动生成会话 |
| service.getAddress() / getError() | 监听快照或 null；脱敏运行时错误或 null | sessionId 只用于识别服务重启，认证不在这层 |
| service.stop() | Promise&lt;void&gt; | 停止接纳、关闭连接、取消并等待 worker/缓存清理；失败保留所有权，下次 stop 重试 |
| service.retryCleanup() | Promise&lt;void&gt; | 主进程明确重试终态缓存；活动任务报 busy；不重放请求或内容 |

路由和包络见[传输协议](transfer-protocol.md#4-http-路由与会话)。除了 device 均核对唯一会话头。JSON 严格 UTF-8、无 BOM/重复解码键、深度不超过 128，按实际 UTF-8 字节执行 8 MiB 请求及响应预算；拒绝编码体、trailer、重复头、歧义 CL/TE、非法/重复查询、错误方法和 Range。

`transfer-registry.ts` 原子接纳后占用单次 ID；下载内容仅 sender ready 可原子领取一次。每个进程仅一个活动批次，覆盖准备、ready、发送、取消和清理。ready 10 分钟、总期限 30 分钟、发送无进展 60 秒，查询不续期；请求/响应无进展 60 秒、整个 HTTP 请求 30 分钟、请求头 15 秒及 16 KiB 头预算。终态保留 10 分钟，已用 ID 保留到服务停止，最多 4096 个。

sender 的 sent 表示本机发送流完成，Android 是否接收或发布要看 receiver 的结果。失败、取消和超时等待实际 IO 结束再清理；清理失败保留互斥，明确重试成功后才释放。主进程 before-quit 同时等待 HTTP 服务与发布适配器停止；清理失败显示错误并保留重试机会。

## 11. 旧 v1 新文件发布与接收

`src/main/new-file-publisher.ts` 的 `WindowsNewFilePublisher` 只供旧 v1 批量接口使用，只在明确授权的专用测试根中创建新文件；应用内的复制与恢复走第 13 节的受保护写入器。写授权只在本进程存活；退出会撤销授权、取消未发布操作并等待候选清理。

| 原生 API | 输入/返回 | 生命周期与失败 |
| --- | --- | --- |
| new WindowsNewFilePublisher(source, options?) | 目录适配器；可选 maxFileBytes 及受信任 IO 注入 | 文件预算只能收紧；不支持安全硬链接时失败，不降级覆盖 |
| grant(rootId) / revoke(rootId) | 已登记本地根 ID | 显式本机授权；撤销等待正在操作的原生 worker |
| checkTarget(request) | 只读预检，返回物理父目录 dev/ino 与大小写比较键 | 不预留名称，发布时仍重查 |
| publish(request, input, options?) | 原文 Readable；返回 outcome 与清理状态 | 接管并最终关闭输入；未确认结果为 unknown，不自动重放 |
| retryCleanup() / stop() | Promise&lt;void&gt; | 清理失败保留身份和进程名额；明确重试成功后释放 |

发布在目标父目录以 `wx` 创建随机 `.savedata-new-<UUID>.tmp` 候选；输入按不超过 64 KiB 分块写入，实测长度/SHA-256、sync 并关闭后，通过 `fs.link(candidate, target)` 排他创建最终名称，再读回复验。其他卷或网络文件系统没有验证，无法安全硬链接时发布失败；特殊 Unicode/8.3 名称的覆盖还没补齐。

注入 publisher 后服务支持 POST uploads 和单次 PUT content。POST 逐项只读预检并以物理父目录/小写名称键检查重复目标，成功后进入 awaiting-content 并返回 201。PUT 校验唯一的 application/gzip、Content-Length 和 x-archive-sha256；`ArchiveReceiveOptions.onArchiveStored` 在压缩体完整落盘且长度/SHA-256 匹配后触发，HTTP 返回 202 的 verifying 快照，归档继续异步完成解包和完整校验后，`upload-receiver.ts` 才按清单顺序发布。整批校验失败时结果全部为 not-attempted/batch-invalid。receiver 等内容期限为 2 分钟，完整消息收齐后即使响应连接丢失，本机仍继续校验和发布。

所有权与写授权只在当前进程内有效。崩溃或强制退出可能留下目标卷候选；复制写入时 `WindowsSyncWriter` 开始写目标目录前删除其中的候选文件，扫描也跳过它们。真实断电及其他文件系统还没验证。

## 12. 独立备份与恢复材料

`createWindowsBackupStore(adapter, privateDirectory, gameName)` 在 `userData/backups/` 初始化独立备份，结构和移动端相同：`<游戏名>/<UTC 时间>/` 内含 `backup.json` 和按原路径保存的 `files/`。`gameName` 只决定新备份的文件夹名，备份归属看 `backup.json` 里的 ID。启动时登记备份区，目录适配器拒绝把它及其父子目录选作同步根。用户可以随时删改这个文件夹，所以每次按实际目录读取；整个文件夹被删后自动重建，设置在 `userData/backup-settings.json`。备份不进入同步比较，清除应用数据会丢失备份。

| 原生方法 | 输入、输出和资源责任 |
| --- | --- |
| `settings()` / `setPreference(projectId, policy)` | 独立 `SyncBackupSettings`；缺少设置项时开启，坏设置拒绝修改并保留原文件 |
| `create(plan, options?)` | 接受有效、可执行且目标设备匹配的 `SyncPlan`，写入前保存目标目录的全部文件；返回 `{ manifest, cleanupError }`，关闭备份、没有写入或目标没有文件时 manifest 为 null |
| `capacity(requiredBytes)` | 预检私有卷剩余空间；可得量未知为 null，不足抛 insufficient-space；不提前删除有效旧轮次换空间 |
| `list(projectId)` | 返回这个游戏的已提交清单和未完成轮次 ID，包括游戏之前用过的目录的备份；恢复必须 acquire |
| `acquire(projectId, backupId, options?)` | 完整核对每个原文文件后返回原生句柄；`snapshot()` 为本次恢复建立临时树，`openFile(fileId)` 返回只读 stream 与 verifyUnchanged；消费者关闭读流后 release |
| `rotate(projectId)` / `cleanupIncomplete(projectId, backupId)` | 显式重试轮换或清理未提交、文件缺失或大小不符的轮次；有效备份和正在被恢复引用的轮次不通过这个入口删除 |
| `deleteBackup(projectId, backupId)` | 用户确认后删除一份备份；先撤下清单，中途失败时变成可清理的残留；正在被恢复引用时拒绝 |
| `deleteGameBackups(projectId)` | 移除游戏时删除它在所有目录下的备份、残留和单独设置；失败时游戏保留，可以重试 |
| `stop()` | 应用退出时取消正在创建/校验的备份并等待资源释放 |

创建时清单先写成 `in-progress.json`，每个文件复制前后核对来源的大小和修改日期、核对复制的字节数，复制出的文件带上来源的修改日期；全部完成后原子改名为 `backup.json`。默认期限 30 分钟；不超过 16 MiB 的文件整个读入后写出，更大的按 1 MiB 分块。预算、清单和恢复规则见[复制、备份与恢复约定](sync-copy.md)。

每个游戏保留的份数取备份设置（1–10，默认 3），不分目录，只统计完整的备份。新轮可读后才轮换；活动恢复句柄保护输入轮次。淘汰先把 `backup.json` 改回 `in-progress.json` 再删文件。文件缺失或大小不符的备份和未提交的一样显示为不完整，不能恢复，不挡新备份，须明确清理；读不懂的内容直接忽略，不自动删除。

有限 `window.desktopBackups` 只提供 read/list/manifest/setPreference/rotate/cleanupIncomplete/deleteBackup/deleteGameBackups，输入仅为项目、目录、轮次 ID 和布尔开关。read 的 displayPath 仅供位置展示；列表使用摘要，单轮详情才返回完整清单。

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

“备份与恢复”按游戏读取完整备份与未完成轮次。备份默认开启，关闭前显示目标目录及覆盖提示。本机恢复先读取并验证所选备份、扫描当前目录，生成固定预览，用户确认后由主进程执行。恢复前始终备份当前目录的全部文件，目标独有文件保留，恢复总是写进游戏当前的目录。

`src/main/restore-registry.ts` 的 `WindowsRestoreRegistry` 持有恢复任务。关闭详情、切页或刷新 Renderer 只停止页面轮询；本进程中的任务、预览及实际结果仍可按 ID 查询。网络服务停止不取消本机恢复；应用退出先停止网络编排和恢复，再停止写入器与备份。

冻结的 `window.desktopSync` API 返回 `Promise<OperationResult<T>>`：

| 方法 | 输入与结果 |
| --- | --- |
| `activity()` | 返回进程内目标操作或清理占用状态，用于配置编辑保护 |
| `copies()` | 最多 32 份 `DesktopCopySummary`；`isAwaitingPeer` 只在已确认、移动端还没登记任务时为 true，此时 phase 必为 running |
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

`apps/desktop/test/` 覆盖目录/IPC、归档、HTTP sender/receiver、旧 v1 发布、扫描、备份和受保护写入的最小长期回归，由 `pnpm test` 运行。测试只覆盖公开接口、数据关系、文件安全和关键传输结果；界面、日志文本和内部调用顺序不进入长期测试。临时夹具基于 realpath 的系统临时根。

Windows 短路径检查通过 PowerShell 调用 GetShortPathName 生成真实 8.3 别名，并在只影响子进程的 TEMP/TMP 环境中重跑目录与 IPC 用例；卷未生成不同短名时跳过这一项。HTTP 测试使用真实回环 HTTP/TCP，时间边界由注入的时钟和仅收紧的期限验证，不等待实际 30 分钟。

实际桌面窗口、系统选择器、Android LAN 双向、取消、清理重试和界面结果已在真机上验收，见[验收标准](../testing/acceptance.md)。
