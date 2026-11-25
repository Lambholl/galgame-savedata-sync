---
doc_type: architecture
status: active
updated: 2026-11-26
tags: [Android, 移动端, SAF, 原生插件]
---

# Android 平台层

## 目录

- [1. 界面入口](#1-界面入口)
- [2. 复制与备份页面](#2-复制与备份页面)
- [3. 系统明暗主题与应用图标](#3-系统明暗主题与应用图标)
- [4. 目录桥与原生边界](#4-目录桥与原生边界)
- [5. 原生归档](#5-原生归档)
- [6. 新文件发布](#6-新文件发布)
- [7. 原生连接与持续通知](#7-原生连接与持续通知)
- [8. 当前扫描](#8-当前扫描)
- [9. 独立备份与恢复材料](#9-独立备份与恢复材料)
- [10. 受保护写入与本机恢复](#10-受保护写入与本机恢复)
- [11. 双向复制编排](#11-双向复制编排)
- [12. 局域网设备搜索](#12-局域网设备搜索)
- [13. 扫码连接](#13-扫码连接)
- [14. 本机服务（监听方）](#14-本机服务监听方)
- [15. 测试范围](#15-测试范围)

## 1. 界面入口

Android 可作拨号方和监听方。作拨号方时原生层连接监听方、编排扫描、计划和任务，并执行监听方经控制通道交来的传输。作监听方时由设备页的“本机服务”开关启动自写的 HTTP 和 WebSocket 服务，用 NsdManager 广播并显示连接二维码，服务开着时由 `connectedDevice` 前台服务和常驻通知保持（[ADR-0004](../decisions/ADR-0004-symmetric-listener-dialer-roles.md)，见第 14 节）。监听方提供连接、目录表交换、双方目录浏览和复制任务的 `/v1/sync/*`；本机作监听方时发起的传输经控制通道交给拨号方执行（第 11 节）。

移动界面在 `apps/mobile/src/app`、`features`、`components` 和 `styles`，使用 antd-mobile；平台接入位于 `src/platform/library-adapter.ts`。界面只从 `@savedata-sync/shared` 引入协议、配置、任务类型和纯数据规则。Android 返回键和系统主题位于 `src/app`；SAF、HTTP 传输桥和配置持久化位于 `src/platform`。

- 设备、游戏、设置三个主页面保留底部导航；打开传输存档、同步计划、备份等子页面时，内容覆盖底部导航区，使用顶部返回键返回。
- 页面切换采用 300ms 淡入和轻微水平位移，主导航按左右顺序切换，详情返回时反向；系统开启减少动态效果时直接切换。普通状态刷新保持当前页面，连续切换会取消上一段动画。
- 点按或长按游戏卡片打开游戏操作菜单（底部卡片），点按或长按已保存的设备打开设备管理；滑动列表会取消长按，从行内按钮开始的长按不打开菜单。长按逻辑在 `src/components/use-long-press.ts`。
- 尺寸：普通按钮 45 CSS px 起、整行主操作 50px；图标点击区 36px 起、选项行 44px，游戏菜单的主操作和次级操作是同一种按钮，56px 起，文字 15px；长文字自动换行并增长高度。标题 18px、常用文字 14px、辅助文字 12px。

可保存多台电脑，一个游戏可关联多台设备，同一时间只连接一台。游戏名称、目录引用和设备关联自动保存到本机网页存储，平台路径和授权留在原生层。添加电脑时默认使用对端的系统计算机名称；移动端向电脑报告系统设备名称，读取不到时使用型号；已有自定义设备名称继续保留。

设备页最上面是本机服务卡片，下面分“已保存的设备”和“附近的设备”两组。

服务卡片用 shared/ui `ServiceHero` 的紧凑排版（`isCompact`）：开关 88px，二维码收进地址旁的按钮；标题和状态胶囊在 360px 宽的手机上也放得下一行，更窄时胶囊换到下一行；地址一行放不下时由 `ServiceHero` 量出实际宽度，按放得下的比例缩小；运行信息只有运行时长和局域网广播状态，连着哪台设备看已保存列表里设备图标的绿点。服务停止时，端口标签、端口号和换随机端口的图标按钮排成一行，图标是两条交叉箭头，左下到右上的一条在交叉处断开，表示从另一条下面穿过（shared/ui `ShuffleIcon`，@ant-design/icons 里没有对应图标）。

已保存的设备按最近连接排序，每次连上把该设备移到开头；设备名不能选中。附近的设备来自局域网设备搜索，只列没有保存过的设备，不列本机自己的广播；已保存的设备行只显示名称和地址，状态只靠图标颜色表示：灰色是离线，蓝色是在线（附近搜到或已连接），已连接再在右下角加绿点；搜到的地址里没有保存的地址时显示搜到的地址；协议版本不同的设备置灰并提示两台都更新。已有设备连接（包括连着本机服务的设备）或正在连接时，其他连接按钮变灰，点击只提示先断开当前设备。连接附近的设备时，`connectCandidates` 按推荐顺序逐个尝试候选地址，并核对设备 ID。

点已保存设备的“连接”时，如果附近已经搜到这台设备、搜到的地址里却没有保存的地址，就直接连搜到的地址，最后再试保存的地址。对方作为拨号方连进本机后保存的设备没有地址，这时只在附近搜到它时显示“连接”。其他情况连保存的地址，同时在后台用 `findDevice` 按设备 ID 查找 5 秒（`DEVICE_LOOKUP_MS`），该行只显示连接中，保存的地址连上就停止查找。连不上、超时或这个地址上是另一台设备时，查到了就依次连它广播的地址，连上后保存的地址换成实际连上的地址，游戏关联按设备 ID 保存，不受影响。没查到时按保存地址的连接失败提示。查找只在点连接时进行。

控制通道（WebSocket）兼作连接心跳。失联后设备显示“未连接”，用与桌面端相同的 antd `message` 提示一次“连接已断开”；持续离线不重复提示，也不诊断原因。主动连接失败同样使用 `message`。

添加游戏会打开弹窗，点击“选择存档目录”直接打开系统文件夹选择器；选好目录后显示游戏名输入框，默认填入父目录名（提供者未返回父目录名时填当前目录名），可以修改后确认添加，取消不会创建游戏。从对端导入游戏时也先选择自己的存档目录。已有游戏可以更换本机目录、选择对应的远端游戏建立关联。选择存档目录时申请并保存系统读写权限；接收前会重新检查权限，权限失效后到目录设置重新选择。

设置页“存储”组有“直接读写文件”和“自动添加 .nomedia”两个开关。“自动添加 .nomedia”默认关闭，存在 `app-preferences` 的 `addNomedia`（布尔值，其他类型按关闭处理）。开关打开时为全部游戏、开着时添加游戏和更换本机目录后为该游戏调用 `Directories.addNomedia`，逻辑在 `src/app/nomedia.ts`。没能添加的游戏只记在内存里，列在开关下方，之后添加成功或关闭开关时移除；关闭开关不删除已经建好的文件。

目录设置显示完整路径。系统存储目录显示文件系统路径，第三方文档提供者显示其可读目录层级或完整文档地址；地址只供显示，实际文件操作仍通过 SAF 引用完成。

适配层 `createMobileLibraryAdapter` 可注入 directories、transfers、control、storage、reloadStorage、service 和 hasSyncWork，默认使用真实原生桥与本机存储；正式入口传入复制/恢复活动查询，编辑配置和空闲失联处理会核对这些任务。发起传输会检查当前项目的两端目录，确认通知权限后再刷新电脑目录表。活动传输结束后再修改游戏目录或关联。手动改 IP 和重启保留原项目映射，连接地址属于另一设备时停止连接。

## 2. 复制与备份页面

“传输存档”页面左右并列展示两端当前层文件，每列独立进入文件夹、返回上级、刷新和滚动。文件名下用小字号同排显示时间和大小，文件夹只显示时间；点文件以整行背景色高亮，选中仅用于浏览，不限定传输范围。

选电脑和方向后点击右下角箭头扫描整个存档目录。完成后进入“同步计划”页，显示新建、覆盖、保留、空目录及冲突；逐项列表隐藏相同内容，实际执行仍使用完整固定计划。返回传输页会保留两列的浏览位置。有冲突或未完成扫描时先处理问题，再重新扫描；内容或目录变化会使旧确认失效。目标多出的内容默认保留，比较页的“− 保留”开关可切到“− 删除”。

扫描箭头和“开始”按钮固定在右下角，距离窗口边缘 24px 并加上系统安全区；页面底部预留 104px 与系统安全区的空间。按钮通过独立浮层渲染，页面位移动画不会改变其位置。

任务页分别显示移动端与电脑的发送/接收阶段、实际字节和文件计数。移动端发送完后，若电脑仍在写入，页面继续查询同一个任务；目标成功取决于接收端回读结果。失败、部分完成、取消、结果待确认及清理错误分别展示。开始传输、目标实际成功、失败和设备连接成功使用 antd Message；状态轮询不重复提示。

“备份与恢复”显示备份库的保留份数（点按打开设置页修改）、本机保存位置、“立即备份”按钮、有效轮次和未完成残留，列表标题显示“已有份数 / 保留份数”。点击“立即备份”直接启动本机手动备份（不弹确认、不填备注），显示实时进度与取消按钮，完成后刷新列表；空目录时提示当前目录没有文件可备份。写入前备份在传输页按次选择，默认关闭；每份备份是一个可以直接删除的文件夹，清除应用数据或卸载应用会一并删除。选择轮次后先核对备份和当前内容，预览并确认恢复；恢复写入前始终会备份当前目录的全部文件。

`src/platform/sync-adapter.ts` 的 `createMobileSyncAdapter(library, dependencies?)` 从持久配置与最新目录表固定项目绑定，在通知授权后再次复核；本机恢复和手动备份也会在执行前核对保存的项目根。`useSyncTasks` 在应用内持续查询复制和恢复所有者，切换页面不取消任务；`currentCopy/currentRestore/currentManualBackup` 恢复本进程任务上下文，查询和清理都不自动调用执行。原生备份设置、手动备份及显式维护与传输、恢复使用同一个目标名额。

## 3. 系统明暗主题与应用图标

页面首次挂载前读取 `prefers-color-scheme`，通过 antd-mobile 的 `data-prefers-color-scheme` 属性切换完整主题，并监听运行时变化。暗色页面、启动及原生窗口背景统一为纯黑 `#000000`。

Android 使用日夜主题及 `values`/`values-night` 的窗口/启动背景，WebView 为透明底色；运行中以 MainActivity 的 `savedata:theme-change` 原生通知（仅含 `isDark: boolean`）为准修正 WebView 缓存的媒体查询，并用 Capacitor 内置 `SystemBars` 显式同步系统栏图标颜色。应用自行渲染暗色，关闭原生自动反色。设置页可选择跟随系统、浅色或深色，偏好保存到原生存储。

应用图标是自适应图标：Manifest 的 icon 和 roundIcon 都引用 `mipmap-anydpi-v26/ic_launcher.xml`，背景层为纯色 `@color/ic_launcher_background`（白色，不随夜间模式变化），前景层为各密度的 `mipmap-*/ic_launcher_foreground.webp`（108 dp 画布，无损 WebP），启动器按自己的形状裁切。minSdk 30 都支持自适应图标，所以没有旧式位图图标。系统启动画面用 `drawable-nodpi/splash_open.webp`，随后由原生开屏覆盖层接管；设置里的“开屏动画”默认打开，关闭时覆盖层只停到网页首屏就绪，不播放眨眼动画。应用页面保留文字标识，不加 logo。

## 4. 目录桥与原生边界

`src/platform/directories.ts` 导出 `androidDirectories`，只提供四个异步方法：

- `chooseDirectory()` 返回共享 `DirectorySelectionResult`；取消保留既有目录。
- `listRoots()` 返回 `OperationResult<readonly DirectoryReference[]>`；保存的引用失去权限时 authorization 为 expired；目录被改名、移动或读取出错时为 unavailable，需要重新选择。
- `addNomedia(rootId)` 在根目录下新建空的 `.nomedia`，返回 created 或 exists；已有同名普通文件时不改动，同名的是文件夹时报 unsupported-operation。新建后按返回的文档 ID 核对名称，SAF 换了名字时删掉新文件并报 source-changed。无论新建还是已有，都按实际路径对根目录调用 `MediaScannerConnection.scanFile`：只新建 `.nomedia` 时媒体库不会重扫所在目录，图片会继续出现在相册里；根目录不属于系统存储提供者时不重扫。需要目录的持久写权限。
- `listDirectory(rootId, parentId = null)` 返回当前层 `OperationResult<DirectoryListing>`，parentId 必须来自当前原生会话枚举出的目录条目。重建进程后先重新列目录，不复用旧 entryId；同一进程的目录桥和传输模块通过 DirectoryRuntime 共享当前引用。

TS 桥校验请求与响应，拒绝路径/URI、附加字段及跨根/跨层响应；原生插件也独立校验请求。网页预览返回 unsupported-operation。

原生代码在 `android/app/src/main/java/io/github/galgame/savedatasync/`：

- `DirectoriesPlugin` 注册系统目录选择器，后台线程串行访问提供者；不在暂停时取消查询，销毁时释放桥执行器。不使用 root。
- `DirectoryStore` 在 SharedPreferences `saf-directories-v1` 的 `registry` 里持久化 schema 2 的根 rootId/URI/显示名；配置损坏或版本未知时失败，不重建覆盖。设备 ID 由 `DeviceIdentity` 单独存在 SharedPreferences `device-identity` 的 `deviceId`，没有时生成。文件清单、文件哈希和 entryId 不持久化。
- `MainActivity` 创建插件前调用 `AppDataRecovery.checkOnce`，每个进程检查一次设备 ID、目录登记、游戏库（`app-storage`）、私有目录里的 `backup-settings.json`、端口（`local-service` 的 `port`）和界面偏好（`app-preferences` 的 `theme`、`locale`、`addNomedia`、`launchAnimation`）。先看目录登记、游戏库和 `backup-settings.json` 有没有 `schemaVersion` 大于当前版本的（规则见 [ADR-0006](../decisions/ADR-0006-stable-release-compatibility.md) 第 9 条）：有就什么都不改，记下这些项，`MainActivity` 只注册 `LaunchAnimation`、`AppPreferences` 和 `AppStorage` 三个插件，网页经 `AppStorage.newerData`（`readNewerData`）读到后只显示“需要更新应用”的提示页，不读游戏配置、不挂载应用。没有时才逐项检查：目录登记、游戏库和 `backup-settings.json` 先按各自的迁移链（`DirectoryStore.REGISTRY_MIGRATIONS`、`ListenerLibrary.LIBRARY_MIGRATIONS`、`BackupModel.SETTINGS_MIGRATIONS`，执行函数是 `DataMigration.migrate`）把基线以上的旧版本迁移到当前版本并写回，SharedPreferences 用 `commit`，文件写临时文件后原子改名；读不懂的 SharedPreferences 值和 `backup-settings.json`（包括低于 1.0 基线和迁移失败的）直接删除，不留副本，各模块随后按没有保存过处理；端口、主题、语言、`addNomedia` 和 `launchAnimation` 只删除类型不对的值，超出范围的端口由 `ListenerRuntime` 重新生成，不认识的主题和语言读成跟随系统、原值保留。目录登记是 schema 2 但有根目录读不出时，只用格式正确且不重复的根目录重写，算作重置；格式版本不是 2 时整个删除。设备 ID 只按 `device-identity` 里的值判断，那里没有值时生成新的，不算重置，也不提示；备份按设备 ID 归属，只列出当前设备 ID 的备份。界面经 `AppStorage` 插件的 `dataResets`、`dismissDataResets`（`src/platform/app-storage.ts` 的 `readDataResets`、`dismissDataResets`）弹一次提示，只列出被重置的项，不提供打开目录的入口：私有目录用文件管理器打不开。
- 当前层查询不扫描后代；目录 sizeBytes=null，未知文件大小=null，空文件=0。SAF 日期 0 表示未知，映射 null；超出 JS 安全范围的数字拒绝。
- `openFile(rootId, entryId, signal)` 仅供同包原生代码使用：重查授权、文件类型和已观察到的名称/大小/日期，以 `r` 打开 `InputStream`，调用者必须关闭流。异常为 `DirectoryFailure`，原始 cause 仅留原生层，JS 只见脱敏码/消息。

目录登记、扫描、备份、打包、写入、新文件发布和本机恢复都通过 `DocumentAccess` 接口访问文件：有所有文件访问权限、目录属于系统存储提供者且能换算出实际路径时用 `FileDocumentAccess` 按路径读写，否则用 `SafDocumentAccess`。两种实现返回同样的文档 ID（`卷 ID:相对路径`）、属性和能力标志，设置页“直接读写文件”显示授权状态并跳转系统授权页，决定见 [ADR-0003](../decisions/ADR-0003-android-direct-file-access.md)。文件内容不进入 JavaScript/Base64，平台路径和 URI 不跨桥。系统存储提供者经树 URI 查询已删除的文档时抛 `IllegalArgumentException` 而不是返回空结果；`SafDocumentAccess.query` 在树根仍能查到时把它当作文档不存在（`FileNotFoundException`），删除后的回查据此确认条目已删除。

## 5. 原生归档

同包 Java 接口由后台 I/O 线程调用，不向 JS 暴露文件流或私有路径。入口为 `DirectoryArchiveSource.createAdapter(context)`。格式见[设备接口与归档格式](transfer-protocol.md#3-归档格式)。

- `sendFiles` 按复制计划的文件顺序读取源文件（`ArchiveAdapter.Outgoing`），边读边写规范 USTAR 和 gzip level 1 到输出流；读取前后核对大小和修改日期，读到的字节数必须等于计划大小，否则返回 `source-changed`。tar 仅含连续 fileId，支持不同目录中的同名源。
- `receiveFiles(sizes, input, control, progress)` 接管并关闭输入，边收边解包到私有缓存：严格检查单 gzip member、DEFLATE 结束、CRC32/ISIZE、全部 USTAR 字段/顺序/零填充/精确结束和每份原文长度；全部通过才返回 `Staged`。
- `Staged.openFile(fileId)` 返回调用者负责关闭的只读流；用完调用 `close()`。源、归档和解包均使用至多 64 KiB 缓冲，逐文件处理。
- `ArchiveModel.Limits` 与共享 `BATCH_LIMITS` 一致，实际私有缓存合计 3 GiB；测试注入只能收紧。
- `checkStagingSpace` 在接收前检查私有缓存能否放下解包原文，容量不足返回 `insufficient-space`。
- `ArchiveControl` 在每次 I/O、解压和进度检查取消、线程中断及 30 分钟总期限；`cancel()` 可从生命周期线程调用，会关闭已登记的读流并取消 SAF 查询。切后台不取消已有传输。
- `ArchiveCache` 仅在私有缓存路径创建 `transfer-archives-v1`，根/随机任务都有所有权标记。每个进程只允许一个任务，句柄和清理失败均占名额。重启只清除可验证的孤儿缓存。
- `ArchiveFailure.code` 为稳定错误码；取消以 `cancelled=true` 区分，清理失败保留主错误并放入 `cleanupFailure`。

## 6. 新文件发布

`NewFilePublisher`/`DirectoryPublicationBackend` 由第 10 节的 `SyncWriter` 用来创建目标里还没有的文件；`SyncWriter` 开始写入时对目标根调用 `grant(rootId)`。系统 WRITE 权限与本次进程显式 `grant(rootId)` 分别检查。

- `parentId` 必须来自同一根已枚举的已有目录；发布流程不创建目录。单项上限 256 MiB，当前层最多 32768 条。
- 创建前拒绝已存在的同名及常见 NFC/大小写等价名称。调用 `createDocument` 后重新枚举，只有返回 ID 是新的、确实位于指定父目录、实际名精确匹配时才写入；回执无法确认时返回 unknown，不猜测删除或重放。
- 只支持可确认为常规文件的描述符；写完重新打开回读完整内容并核实身份、名称、父目录、长度和修改时间后才报告 succeeded。
- 失败/取消只删除本次已知新建且身份仍匹配的条目，清理结果与发布结果分开；`retryCleanup()` 仅重试清理。

SAF 没有通用排他创建或比较后删除原语；这些复核能发现可观察竞争，恶意提供者或并发命名空间变更不在隔离范围内。

## 7. 原生连接与持续通知

`src/platform/http-transfers.ts` 导出 `androidTransfers`。文件字节只经过 Java 原生流，JS 只接收连接、目录和任务状态。

| 方法 | 行为与边界 |
| --- | --- |
| requestNotifications / chooseTarget | 申请通知权限，并通过 SAF 选择器取得目标 WRITE；不接受 URI 或路径参数 |
| connect / disconnect | 连接数字 IP 的 HTTP 地址，核实 v1、Windows 设备/会话/固定预算；有任务持有写入名额（`TargetOperation`）或正在连接时返回 busy |
| connections / selectDevice / disconnectDevice / exchangeCatalog | 连接列表、选择设备、断开和目录表交换，同一时间只连一台 |
| controlStates / sendControl | 读取控制通道状态并发送控制消息 |
| listRemoteRoots / listRemoteDirectory | 校验设备身份、根/父层及唯一条目，仅读取当前层 |
| deviceName | 本机设备名，规则见[接口约定](api-contracts.md) |

`TransferJson` 严格拒绝重复键、坏 UTF-8、未配对代理项、附加内容、超限深度/节点及非安全整数，JSON 单项 8 MiB。`TransferSchema` 校验设备描述、目录列表、条目元数据和错误信封的封闭字段，设备平台接受 `windows`、`linux`、`android`。`TransferRuntime` 持有进程内唯一的 `TransferEngine`，`SyncTransferRuntime` 和 `ListenerRuntime` 共用它的连接。

`TransferHttp.Client` 使用无代理的 HttpURLConnection，明确 identity，关闭自动解压、重定向和缓存。连接和默认网络无进展等待 5 秒。连接失败以短时消息显示原始 HTTP 状态、协议错误码或系统 errno/异常类型。首次 catalog 请求携带 `x-sync-connect: 1`，表示主动建立新连接。取消线程断开连接，原 I/O 线程关闭网络缓冲流，避免 Android Okio 与 read 并发 close。

复制任务由 `SyncTransferRuntime` 以应用 Context 持有（第 11 节）。用户发起任务前先确认 `TransferService` 的 dataSync 前台服务和持续通知已启动；Android 13+ 需通知权限。Activity 暂停、销毁或回到桌面后，原任务继续运行；完成/显式取消并清理后服务和通知结束。通知按阶段显示进度：传输用 `transferredBytes`/`totalFileBytes`，备份用 `backupBytesCopied`/`totalBackupBytes`，写入用 `publishedFiles`/`totalFiles`。

声明 FOREGROUND_SERVICE、FOREGROUND_SERVICE_DATA_SYNC、POST_NOTIFICATIONS；服务不导出、START_NOT_STICKY，没有开机接收器、定时同步或旧任务恢复。系统结束服务或进程后，任务不会记成成功，也不会自动重放。

## 8. 当前扫描

`SyncScanner` 提供 SAF 递归扫描（只读元数据，不读内容）、空目录及失败部分结果，复用 `DirectoryArchiveSource` 的权限/身份/属性前后复核。任意层级名为 `.nomedia` 的普通文件不进入快照，规则见[复制、备份与恢复约定](sync-copy.md)第 2 节。`SyncScansPlugin` 只提供 capabilities/start/query/cancel，参数为 schemaVersion/rootId 或 scanId。结果与 Windows 使用同一 SyncScanState，期限、条目/深度/JSON 限制和 32 份结果保留沿用[复制、备份与恢复约定](sync-copy.md)。

`src/platform/sync-scan-bridge.ts` 核对有限参数、完整结果及 rootId/scanId 上下文；query 的成功包络只代表查到任务，扫描是否成功取决于内部 status。

## 9. 独立备份与恢复材料

`DirectoryRuntime.backups(context)` 把持久备份放在 `getExternalFilesDir(null)/backups/`，备份设置放 `getFilesDir()/backup-settings.json`；源文件通过已有 SAF 授权读取。清除应用数据或卸载会一并删除备份。

每份备份的结构是 `backups/<游戏名>/<yyyy-MM-dd_HH-mm-ss>Z/`，时间用 UTC，内含 `backup.json` 和按原路径保存的 `files/`。归属以 `backup.json` 里的 ID 为准，游戏改名、用户改文件夹名都不影响列表；游戏名不能作文件名的字符换成 `_`，超过 60 个字符截断，仍不可用时用游戏 ID。缺文件的备份显示为不完整，可以清理但不能恢复，也不挡新备份；读不懂的内容被忽略，`backups` 被整个删除后自动重建。轮换时不完整的备份（含未提交的）也占保留份数，超出时先删它们，再删最旧的完整备份。文件是否齐全只看文件在不在和大小；内容哈希只在创建和恢复时校验。同时有 `backup.json` 和 `in-progress.json` 的备份按已提交处理。

应用关闭了系统自动备份和设备间迁移（`allowBackup="false"` 加 `data_extraction_rules.xml`）：存档备份不上传云端，重装后也不会恢复已失效的目录授权和旧设备 ID。

| 原生接口 | 输入、输出与资源责任 |
| --- | --- |
| `BackupStore.create(projectId, rootId, reason, shouldBackup, entries, control)` | 传入目标目录的全部文件项；返回 `{ manifest, cleanupError }`；关闭备份、没有写入或目标没有文件时 manifest 为 null，reason=restore 强制开启保护 |
| `list` / `manifest` | 按游戏返回轮次摘要（包括游戏之前用过的目录的备份）和未完成 ID，或按 backupId 取得单轮清单；恢复前必须 acquire |
| `settings` / `setKeepCount` / `capacity` | 备份库设置文件不存在时为默认 10 份，旧格式由 `AppDataRecovery` 迁移，低于 1.0 基线或迁移失败时删除并提示；容量未知为 null，不足返回 insufficient-space |
| `acquire(projectId, backupId, control)` | 重新核对全部原文后返回 Handle；引用期间不淘汰该轮 |
| `rotate` / `cleanupIncomplete` | 明确重试轮换或清理归属已核实的未提交/已淘汰轮次 |
| `deleteBackup` / `deleteGameBackups` | 删除一份备份，或移除游戏时删除它在所有目录下的备份；被恢复引用时拒绝，失败可重试 |
| `close` | 取消当前操作、等待文件释放；已提交备份持久保留 |

`BackupModel` 与共享备份 v1 清单一致，允许 `copy`、`restore` 与 `manual` 三种原因。多个线程同时复制目标文件，每个文件复制前后核对来源的大小和修改日期、核对复制的字节数；全部完成后原子提交清单。每个游戏保留的份数取备份设置（1–4096，默认 10），自动与手动备份平级轮换，新轮提交后才轮换。`BackupFiles` 只访问已核实的私有普通文件，身份和链接数由 `Os.lstat` 读取。

`DirectoryRuntime.manualBackups(context)` 持有进程内共享的 `ManualBackupRuntime`：启动时占用与传输、恢复相同的 `TargetOperation` 名额，在单工作线程中通过 `SyncScanner.snapshotNow` 扫描当前目录并调用 `BackupStore.create(..., "manual", true, ...)` 提交，终态按 10 分钟保留供查询，Activity 销毁后任务继续。

`src/platform/backups.ts` 导出 `androidBackups`，只提供 read/list/manifest/setKeepCount/rotate/cleanupIncomplete/deleteBackup/deleteGameBackups 及手动备份接口 startManual/currentManual/manualState/cancelManual，参数只有公开 ID 和保留份数。

## 10. 受保护写入与本机恢复

`SyncPlanModel` 从两端完整快照重新推导全部动作、顺序、条目引用和预算。`SyncWriter.apply(plan, material, control)` 目标必须为本机，方向为 listener-to-dialer 或 local-restore；接纳后返回完整 `SyncApplyResult`。

写入前重扫目标，核对计划与目标的大小和修改日期；备份开启且有写入时，备份前也重扫一次，再保存目标目录全部文件。目录授权每个任务核对一次，读写循环里只检查期限、取消和任务归属。原地覆盖按文件增量预检目标空间，并合计已知同卷的备份峰值；备份落盘后再查目标实际余量，覆盖 SAF 与备份目录逻辑设备 ID 不同但共用物理空间的情况。

`DirectorySyncBackend` 创建目录后核实文档 ID、类型、原始名称及父目录；新文件复用非覆盖发布器。覆盖和删除只查询目标文档本身，父目录用扫描时登记的引用，不列父目录。覆盖以 `rw` 打开一次常规 FD 作为身份句柄，核对名称、类型、链接数、大小和日期，写入前再用 fstat 确认大小、修改时间和状态改变时间没变，然后经这个 FD 写入；拒绝虚拟文档、额外硬链接和无法核实的文件。这期间同一路径的文件被换掉时，内容写进旧文件。`rw` 打开保留旧内容，完整写入并核对字节数后才设置最终长度，再尽量把修改日期设为来源的（经 SAF 写入时设不了）。

第一项失败、取消或未知后停止后项，已确认成功的文件和目录保留。删除排在所有写入之后；删除文件前核对身份、大小和修改日期；`deleteDocument` 会递归，所以文件夹先确认里面没有别的条目再删，只剩 `.nomedia` 时先删它。写入中断后返回 unknown/result-unknown，旧内容仍可从有效备份读取。备份之后、第一次写目标之前，`InterruptedWrites` 在私有目录 `interrupted-writes/<planId>.json` 落盘标记，结束时删除；上个进程留下的标记由 `SyncWrites.interrupted()` 读取、`dismissInterrupted({ id })` 清除，界面据此提示一次。旧传输、新复制和本机恢复共用 `TargetOperation` 进程互斥。

`SyncWriteRuntime` 由应用 Context 持有；最多保留 32 份预览/结果，预览和终态保留 10 分钟。

| `SyncWrites` / `androidSyncWrites` 方法 | 输入、输出及资源责任 |
| --- | --- |
| `bindProject(projectId, rootId)` | 平台层先核对已保存的游戏配置，再绑定已有授权根；活动任务/清理期间拒绝改绑 |
| `prepareRestore(projectId, rootId, backupId)` | rootId 是游戏当前的目录；返回 preparing 状态和新 restoreId；恢复强制先备份当前内容 |
| `preview(restoreId)` | 取得固定的源/目标快照；TS 生成同一 planId、固定 `shouldDeleteExtras = true` 的本机恢复计划 |
| `execute(restoreId, plan)` | 核对项目/根、原生固定预览及完整计划，只执行一次；通过 `SyncWriter.Observer` 汇报备份与写入阶段和字节/文件进度；重复执行返回 task-conflict |
| `query` / `cancel` / `current` | 查询实际状态（含 `stage`、`failureStage`、`updatedAt` 与 `progress`）、显式取消，或取回本进程最近的 restoreId |
| `release(restoreId)` / `retryCleanup()` | 放弃预览或释放终态数据，明确重试未释放资源 |

## 11. 双向复制编排

`SyncTransferRuntime` 由应用 Context 持有 `SyncTransferEngine`；复用同一原生连接和归档缓存。`SyncJobModel` 核对目录表中的双向项目关联、当前快照、源清单和 receiver 的完整逐项结果。协议见[复制、备份与恢复约定](sync-copy.md#6-http-与本地桥)。

| `SyncTransfers` / `androidSyncTransfers` 方法 | 输入、输出与资源责任 |
| --- | --- |
| `prepare(binding, direction)`、`queryPreparation`、`preview`、`cancelPreparation` | 普通扫描生成异步准备状态，预览返回两份快照及目标备份开关。新准备取代还没结束的旧准备。准备阶段不占传输名额或启动保活 |
| `execute(preparationId, plan)` | 核对同次预览与完整计划，消费一次确认并取得进程名额；系统接受传输通知后才登记远端任务 |
| `query(jobId, shouldRefresh?)`、`manifest`、`current`、`latest(projectId)` | 读取两个角色的状态、公开元数据清单、最近任务 ID；`shouldRefresh` 只查询原远端任务，不续期、不重放 |
| `cancel`、`release`、`retryCleanup` | 显式取消并读取 receiver 实际结果，释放预览/已结束任务，或重试缓存清理 |

Android → Windows（拨号方 → 监听方）：确认后先登记目标任务，再按计划顺序从 SAF 流边读边打包上传（chunked PUT），逐文件读取前后核对大小和修改日期。上传期间每 3 秒查询原任务作为通信心跳，电脑仍在备份时每秒刷新它的进度。sender sent 只表示已发送，最终结果以 receiver 的 `SyncApplyResult` 为准。无文件的计划不生成空归档。

Windows → Android（监听方 → 拨号方）：按确认计划里发起端的备份选择；Windows 发送端 ready 后移动端核对确认计划，再检查缓存、备份和目标增量的已知同卷峰值。内容 GET 只领取一次，Windows 边读边打包发送，移动端边收边解包；完整校验通过后 `SyncWriter` 重新扫描目标、提交保护备份并逐项写入。备份清理或轮换失败不占名额，也不挡下一次传输，界面不提示；恢复流程会提示。

确认执行后才使用 dataSync 服务和持续通知；插件销毁不会中断任务。任务总期限 30 分钟，预览/终态最多保留 10 分钟、各最多 32 份，已用任务 ID 最多 4096 个。

`SyncTransferRuntime` 同时是监听方任务的入口，按对方设备选路：本机服务的控制通道连着这台设备时，准备、预览、执行走 `ListenerSyncRequests`，任务的查询、取消、清理重试走 `ListenerSyncJobs`；否则走拨号方的 `SyncTransferEngine`。`ListenerLibrary` 在本机拨号时拒绝目录表交换，所以同一台对方设备不会同时是两种角色。监听方的预览 `localSide` 为 `listener`，网页层用共享包的 `isPreviewLocalSource` 判断本机是发送端还是接收端。

拨号方在本机登记任务时同样启动 `TransferService`，由 dataSync 持续通知保持；任务由对方发起时插件发 `peerJobStarted`（`jobId`、`projectId`），网页层切到该任务的传输详情（REQ-023）。目标授权核对按名额归属分开：`ListenerSyncJobs` 持有名额时由它核对任务上下文，否则交给 `SyncTransferEngine`。

错误归属：内容 GET 和 PUT 失败时错误直接回在 HTTP 应答里，`ListenerSyncJobs` 给其中文件、目录和存储访问类的错误码（`SyncTransferEngine.DEVICE_ERRORS`）注明 `device: listener`，`ListenerServer` 把本机的 `DirectoryFailure` 同样注明 listener。Android 拨号方 `TransferHttp` 保留 HTTP 错误里的 device；没注明的授权失效由 `SyncTransferEngine` 按本机目录处理。

## 12. 局域网设备搜索

`src/platform/device-discovery.ts` 导出 `deviceDiscovery`，用 NsdManager 搜索 `_savedata-sync._tcp` 服务，格式见[共享包](shared-package.md#9-发现与连接二维码)。

- `watch(listener)`：第一个订阅者开始原生搜索，最后一个取消订阅后停止；listener 先收到当前结果，之后每次变化收到完整结果。
- `retry()`：status 为 failed 时重新开始搜索。

结果 status 为 `searching`、`failed` 或 `unavailable`（浏览器预览）。同一设备 ID 出现在多个实例名下时合并；不合法的服务丢弃，协议版本不同的只把实例名放进 incompatibleNames。

原生部分是 `DeviceDiscoveryPlugin` 和 `DiscoveryBrowser`（全部状态在一个 worker 线程上）。API 34 及以上对每个服务注册 ServiceInfoCallback；更低版本用 resolveService 逐个解析，10 秒没有回调就跳过，FAILURE_ALREADY_ACTIVE 隔 1 秒重试，最多 3 次。只保留 IPv4 地址。解析出的服务要请求 `/v1/device` 得到 200 才出现在结果里，搜索期间每 5 秒重新探测，已出现的服务连续 2 次失败后去掉，所以停止服务的设备最多约 10 秒后从结果里消失。离开的设备不一定发出 goodbye 包（断网、断电，也有系统注销广播后不发 goodbye、继续应答查询的），只靠 mDNS 记录过期要等很久，所以用探测判断是否在线。Activity 停止时暂停搜索并清空结果，回到前台时重新搜索。网页重载后原生搜索可能还在进行而没有订阅者，模块加载时先停止一次。系统 NsdService 负责组播，应用不申请 MulticastLock。

## 13. 扫码连接

设备页标题栏的扫码按钮打开 `src/features/devices/ScanPage.tsx`，已有设备连接时只提示先断开。打开页面时申请相机权限并开始扫描，离开页面即关闭相机。有效的连接二维码回到设备页依次尝试候选地址并核对设备 ID；协议版本不同时提示两台设备更新；其他二维码提示“不是连接二维码”并继续扫描。没有相机权限时提供“去系统设置”和“手动输入”，授权后返回会自动开始扫描；相机打不开时提供“重试”和“手动输入”。

`src/platform/qr-scanner.ts` 导出 `qrScanner`：`start()` resolve `started`、`denied` 或 `failed`，不会 reject；`stop()`；`watchDetected(listener)` 同一段文本每 2 秒最多一次；`watchPermissionGranted(listener)` 在回到前台且已授权时调用；`openAppSettings()`。

原生部分是 `QrScannerPlugin`、`QrCameraSession`（CameraX）和 `QrFrameDecoder`（ZXing）。取景画面是插在透明 WebView 下面的 `PreviewView`（TextureView 模式）；相机打开后 `ScanPage` 在 html 上加 `camera-live`，由 `mobile.css` 让出页面背景。解码只开 QR 格式和 `ALSO_INVERTED`，监听方深色主题的反色码走翻转路径；识别用完整的分析帧，取景框只是对准提示。

## 14. 本机服务（监听方）

原生部分只用 JDK 和 Android SDK，每条连接一个线程：

| 类 | 职责 |
| --- | --- |
| `ListenerServer` | 在 `0.0.0.0` 的保存端口监听，开启地址复用，停服后马上重开不受 TIME_WAIT 的旧连接影响；绑定失败报 `port-unavailable`。最多 16 条连接，空闲 60 秒（控制通道 45 秒）关闭。路由 `/v1/device`、`/v1/catalog`、`/v1/roots`、`/v1/roots/<rootId>/entries`、`/v1/control`；除 `/v1/device` 外都核对 `x-sync-session-id`，控制通道还要求已交换目录表的 `x-sync-device-id`，不满足返回 403。`/v1/sync/*`（能力、扫描、项目描述、任务登记、内容 GET 和 PUT、查询和取消）同样核对会话，并要求 `x-sync-device-id` 是已交换目录表的设备；扫描和任务的 DELETE 在进行中时回 202，内容 GET 用 chunked 200，PUT 只接受 chunked 并回 202 |
| `ListenerSyncJobs` | 对应电脑 `DesktopSyncRegistry`：拨号方登记的复制任务，本机可以是接收端或发送端。本机接收时内容只接受一次，边收边解包到私有缓存，收齐后由 `SyncWriter` 写入；本机发送时重新扫描核对来源，内容只能读取一次。从登记到写入和缓存清理结束占用 `TargetOperation` 名额。期限与电脑相同：ready 10 分钟、等内容 2 分钟、总期限 30 分钟、网络无进展 60 秒；终态保留 10 分钟，最多 32 个任务、4096 个已用 ID，只在内存中。错误回复的 `canRetry` 一律为 false，与电脑服务相同。停止服务时立即返回，中止当前任务后在后台线程最多等 30 秒完成清理 |
| `ListenerSyncRequests` | 对应电脑 `remote-sync-requests.ts`：本机作监听方时发起的传输。经控制通道发 `sync.prepare` 请拨号方扫描，收 `sync.report` 的计划后由用户确认，再发 `sync.confirm`，拨号方执行并在本机登记任务；同一时间只保留一个请求。拨号方以 invalid-request 或 not-found 拒绝确认（计划已过期）时按 not-found 返回，界面重新准备 |
| `ListenerHttp` | HTTP/1.1 请求解析和回复，规则与电脑服务相同：头名重复、Content-Encoding、Range、Expect、Content-Length 与 chunked 冲突、chunk 扩展和 trailer 都按 invalid-request 拒绝；JSON 请求体最多 8 MiB |
| `ListenerSocket` | 服务端 WebSocket（RFC 6455），只收文本帧，单条最多 8 MiB；关闭时先发关闭帧，最多等 2 秒回应 |
| `ListenerControl` | 控制通道监听端：同一时间一条连接，同一设备的新连接以 4002 取代旧连接，主动断开用 4001。每 15 秒 ping，请求 8 秒超时。对方发来的请求交给 `requests` 登记的处理函数，在单独的应答线程上执行；目前只应答 `poster.read`，其他方法答复 unsupported-operation |
| `ListenerLibrary` | 目录表交换，规则与电脑监听方相同：屏蔽的设备 permission-denied；被断开的设备要带 `x-sync-connect: 1` 重新连接，否则 session-mismatch；本机正在拨号或已有别的设备在线时 busy；最多 32 台设备。新连接把设备移到已保存列表开头，合并对方的关联后写入配置。配置的读、改、写在 `ListenerLibrary` 的锁里完成；关闭控制连接和通知网页层配置已变都在锁外进行。经控制通道 `directory.list` 浏览对方目录，父目录必须是本会话读到过的条目 |
| `ListenerAdvertiser` | NsdManager 注册 `_savedata-sync._tcp`，TXT 与电脑相同；注册失败 30 秒后重试，停止服务时注销 |
| `ListenerRuntime` | 应用 Context 持有的单例：开关和端口保存在 SharedPreferences（`local-service`），首次生成 49152–65535 的随机端口，服务停止时才能换端口。本机地址优先 Wi-Fi 和以太网，再是热点，排除移动网络、VPN、回环、链路本地和 198.18/15，最多 8 个 |
| `ListenerService` | `connectedDevice` 前台服务，常驻通知显示推荐地址和连着的设备，带“停止”操作。不导出、`stopWithTask=false`、START_NOT_STICKY，没有开机启动 |
| `LocalServicePlugin` | 网页接口；`handleOnResume` 时开关开着而服务没在运行（进程被系统结束过）就重新启动，启动失败则关掉开关 |

目录表交换在原生层完成，Activity 销毁后对方仍能连接。游戏库配置因此有两个写入方：`AppStoragePlugin.readLibrary` / `writeLibrary` 加同一把锁，原生层写入后发 `libraryChanged`，`library-adapter` 重新读入配置并丢掉缓存。网页的写入经 `appStorage` 按顺序交给原生层；`saveGames` 等写入落盘（`flushAppStorage`）后才发 `catalog.changed`，否则对方立即重新交换时原生层还读到旧的游戏和关联。读快照时还会补登记连着本机、配置里却没有的设备，防止网页的旧缓存覆盖原生层刚写入的设备。

`src/platform/local-service.ts` 导出 `localService`（桥接在 `local-service-bridge.ts`）：status、start、stop、randomizePort、peers、disconnectPeer、peerDirectory、peerPoster、catalogChanged，以及 `serviceState`、`libraryChanged` 两个事件。`library-adapter` 把连着本机的设备并入快照的 peers，并在 `listenerPeerIds` 列出它们的设备 ID，传输页据此按本机是监听方决定方向和两端位置：控制通道连着即在线，游戏取对方最近发来的目录表；浏览这台设备的目录走 `peerDirectory`，导入它的游戏时取封面走 `peerPoster`，断开和删除走 `disconnectPeer`，修改本机游戏后发 `catalog.changed`。打开开关前申请通知权限，没有授权时不启动。

声明 `FOREGROUND_SERVICE_CONNECTED_DEVICE`，以及该前台服务类型要求的前置权限之一 `CHANGE_WIFI_MULTICAST_STATE`。

## 15. 测试范围

移动端网页层没有长期测试。`ListenerServerTest` 在 JVM 回环地址上运行真实的本机服务，覆盖 HTTP 解析边界、目录表交换、控制通道和一台设备一条连接的规则，以及 Android 拨号方 `TransferEngine` 连接、交换、浏览后被 4001 断开。监听方 `/v1/sync/*` 和控制通道发起的传输没有长期测试，验收结论见[验收标准](../testing/acceptance.md)第 3 节。`pnpm android:unit` 同步 Web 工程，生成 Windows 原生归档供 Java 消费，执行 Java 单元测试，最后验证 Windows/JVM 归档互通；`pnpm android:test` 在此之外另跑 Android lint、调试与仪器测试 APK 构建。两者都不连接设备。

设备测试有 4 项，安装两个调试 APK 后用 `node scripts/device/device.mjs instrument <类名#方法名> [键=值...]` 运行，键值对作为 `-e` 参数传给测试，`cache` 下的产物用 `private-pull cache/<文件名> <输出>` 取回：

- `ArchiveSafTest#androidConsumesPythonAndWindowsNativeArchivesAndExportsJavaArchive`：跨端归档固定夹具。设备生成的 `cache/archive-device-java.gz` 取回到 `.reports/wp013-device/java.gz` 后，用 `scripts/verify-archive-interop.mjs verify-device` 复核。
- `DirectoriesTest#pickerSelectionAndNativeRead`（`safMode=select safExpectedName=<显示名>`）：先准备 `SaveDataSync-Archive-<随机后缀>` 合成目录，由测试者在系统选择器中授权。
- `CompatSamplesDeviceTest`（两个方法）：用 `org.json` 解析兼容样本，核对目录登记样本读出再写回不变，`AppDataRecovery.isNewer` 只把 `schemaVersion` 更高的目录登记、游戏库和备份设置算作较新版本。样本从测试 APK 的 assets 读取，不读写应用私有数据。
- `ArchiveSafTest#actualSafStreamsRoundTripWithoutChangingSource`（`archiveExpectedName=<显示名>`）：从同一合成目录边读边打包，再在设备上解包核对，确认源文件没有变化；设备生成的 `cache/archive-device-saf.gz` 和 `cache/archive-device-saf-files.json` 取回为 `.reports/wp013-device/saf.gz` 和 `saf-files.json` 后用 `verify-device-saf` 复核。

界面主题、按钮和具体文案由实际运行与截图验收。真机操作和检查用 `scripts/device/` 的工具，用法和安全边界见 `docs/development.md` 的“真机调试工具”；读应用页面用 CDP 取文字，有的手机上 uiautomator 一直等不到界面空闲，`ui-text` 读不到界面（测试手机上关掉无障碍服务后照样如此，原因没查清）。真机验收范围见[验收标准](../testing/acceptance.md)。

调试包诊断接口用于真机上查看状态和注入故障，用法见 `docs/development.md` 的“诊断与故障注入”：

- 编译范围：`src/debug` 的 `DebugDiagnostics` 广播接收方和 `FaultInjection` 故障开关只编进调试包；`src/release` 有同名的 `FaultInjection` 空实现，原样返回实际值、不登记连接。main 源码集里的调用点两种构建都编译，`pnpm android:test` 会编译一次 release，确认两份 `FaultInjection` 的签名一致。
- 访问控制：接收方只在 `src/debug/AndroidManifest.xml` 声明，导出但要求 `android.permission.DUMP`，只有 adb shell 能发这个广播，设备上的其他应用发不了。
- 注入点：目标目录的可用容量（`DirectoryPublicationBackend.availableBytes`）和写入（新文件发布流、`DirectorySyncBackend` 的覆盖写入流）；备份的可用容量和写入（`AndroidBackupIo`）；接收内容时暂存归档的私有缓存的可用容量和写入（`DirectoryArchiveSource` 交给 `ArchiveCache` 的 `Io`；发送时边读边打包直接发出，不经过这个缓存）。`drop` 关闭的连接由 `ListenerServer`、`TransferHttp` 的请求和 `ControlClient` 登记，用弱引用保存。
- 真机验证：`status` 在应用运行和未运行时都能输出；`drop` 后控制通道断开，5 秒内重新连上；备份区域报告容量为 0 时，手动备份提示存储空间不足，没有生成备份；备份区域每次写入等待 300 毫秒时，备份变慢但照常完成。`target` 和 `cache` 区域用电脑到手机的传输验证（来源是电脑上的合成测试目录，目标是手机上的测试目录，约 1.1 MiB）：任一区域报告容量为 0 时，传输失败并提示本机存储空间不足，目标没有写入任何文件；`target` 每次写入等待 300 毫秒时，新建文件和覆盖写入都从约 2 秒变慢到约 12 秒，`cache` 同样等待时传输阶段约 8 秒，都照常完成。手机接收失败时会取消电脑的任务，电脑上这次传输显示为已取消，不显示原因。

数据读不懂时的启动检查（`AppDataRecovery`）只有较新版本的判断规则由 `CompatSamplesDeviceTest` 覆盖，检查和删除私有数据的流程没有长期测试；游戏库、备份设置和备份样本迁移后的读取，以及三条迁移链从基线到当前版本每个版本各有一步，由 JVM 单元测试 `CompatSamplesTest` 覆盖；迁移执行函数的规则由 `DataMigrationTest` 覆盖。数据由更新版本写入时的处理在真机上验证过：游戏和设备列表写成更高的 `schemaVersion` 后冷启动，只显示提示页，本机服务没有恢复，应用私有数据原样保留；改回原数据后正常启动。端口和主题的宽容读取还没在真机上验证。
