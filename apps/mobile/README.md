# Android 目录、原生传输与持续通知

## 目录

- [界面入口](#界面入口)
- [复制与备份页面](#复制与备份页面)
- [系统明暗主题](#系统明暗主题)
- [应用图标](#应用图标)
- [原生边界](#原生边界)
- [原生归档接口](#原生归档接口)
- [原生新文件发布](#原生新文件发布)
- [原生 HTTP 与持续通知](#原生-http-与持续通知)
- [独立备份与恢复材料](#独立备份与恢复材料)
- [受保护写入与本机恢复](#受保护写入与本机恢复)
- [双向复制编排](#双向复制编排)
- [验证](#验证)

## 界面入口

点按或长按游戏卡片打开游戏操作菜单；滑动列表会取消长按。

移动界面独立维护在 `src/app`、`src/features`、`src/components` 和 `src/styles`，使用 antd-mobile；平台接入位于 `src/platform/library-adapter.ts`。设备、游戏、设置为三个主入口；可保存多台电脑，一个游戏可关联多台设备，首期同时只连接一台。游戏名称、目录引用和设备关联自动保存到本机网页存储，平台路径和授权仍留在原生层。

添加游戏会打开弹窗，点击“选择存档目录”直接打开系统文件夹选择器；选好目录后显示游戏名输入框，默认填入父目录名，可以修改后确认添加，取消不会创建游戏。提供者未返回父目录名时先填当前目录名。从对端导入游戏时也先选择自己的存档目录，再添加游戏关联。已有游戏可以更换本机目录、选择对应的远端游戏建立关联。

目录设置显示完整路径。系统存储目录显示文件系统路径，第三方文档提供者显示其可读目录层级或完整文档地址；地址只供显示，实际文件操作仍通过 SAF 引用完成。

复制页选择方向后扫描整个存档目录，按当前内容生成计划。逐项计划并列展示来源与目标属性，区分不存在、未知属性和扫描失败；时间精确到分钟，文件夹不汇总大小。操作采用 antd-mobile 按钮和整行选择，目录与地址完整显示。

选择存档目录时申请并保存系统读写权限。配置好目录并连接设备后即可接收文件；权限有效时不用再次授权，接收前会重新检查权限，权限失效后到目录设置重新选择。

手机可发起两个方向的复制，确认后新建或覆盖目标文件，保留目标独有内容。覆盖前备份默认开启，可在目标本机关闭；备份列表提供本机恢复预览与确认。任务页显示真实进度、取消和逐项结果，镜像删除留在后续里程碑。

地址单独保存在本地网页存储，目录引用及系统授权由原生层保存。传输由原生通知保持运行，页面重载通过 `current()` 取得同一传输任务。任务结果与当前比较计划分开展示；重启应用沿用已保存的目录、系统权限和有效备份，旧任务重新扫描确认。

元数据轮询兼作连接心跳。失联后设备显示“未连接”，用与桌面相同的 antd `message` 提示一次“连接已断开”；持续离线不重复提示，也不诊断原因。主动连接失败同样使用 `message`，提示随系统明暗主题变化。

添加电脑时默认使用对端的系统计算机名称。手机向电脑报告系统设备名称，读取不到时使用型号；已有自定义设备名称继续保留。

`src/platform/saf-directories.ts` 导出 `androidDirectories`，只提供三个异步方法：

```ts
import { androidDirectories } from './src/platform/saf-directories'

const selected = await androidDirectories.chooseDirectory()
if (selected.status === 'selected') {
  const listing = await androidDirectories.listDirectory(selected.directory.rootId)
  // 检查 status；成功空数组、未知属性 null 和错误是不同结果。
}
const roots = await androidDirectories.listRoots()
```

`chooseDirectory()` 返回共享 `DirectorySelectionResult`；取消保留既有目录。`listRoots()` 返回 `OperationResult<readonly DirectoryReference[]>`；保存的引用失去权限时仍存在，authorization 为 expired。`listDirectory(rootId, parentId = null)` 返回当前层 `OperationResult<DirectoryListing>`，parentId 必须来自当前原生会话枚举出的目录条目。重建进程后先重新列目录，不复用旧 entryId；同一进程的目录桥和传输模块通过 SafRuntime 共享当前引用。

TS 桥校验请求与响应，拒绝路径/URI、附加字段及跨根/跨层响应；原生插件也独立校验请求。未安装插件、畸形返回和连接异常转为脱敏错误。网页预览返回 unsupported-operation；系统目录与传输操作使用 Android 应用。

界面只从 `@savedata-sync/shared` 引入协议、配置、任务类型和纯数据规则。Android 返回键和系统主题位于 `src/app`；SAF、HTTP 传输桥和配置持久化位于 `src/platform`。游戏操作采用底部卡片菜单；逐项计划按页展示，每项同时显示两端属性。交互区域至少 48 CSS px，游戏操作卡片至少 64 CSS px。

发起传输会检查当前项目的两端目录，确认通知权限后再刷新电脑目录表。目录或设备关联变化时需要重新打开预览；活动传输结束后再修改游戏目录或关联。手动改 IP 和重启保留原项目映射，连接地址属于另一设备时停止连接。

适配层 `createMobileLibraryAdapter` 可注入 directories、transfers、storage 和 hasSyncWork，默认使用真实原生桥与本机存储；正式入口传入新复制/恢复活动查询，编辑配置和空闲失联处理会核对这些任务。注入仅替换平台依赖，仍运行同一配置持久化与项目复核逻辑；平台接口保留 OperationResult 和原有任务生命周期。

## 复制与备份页面

在游戏菜单选择“传输存档”，选电脑和方向，点击“扫描并预览本次变化”。预览显示新建、覆盖、跳过、保留、空目录及冲突，按每页 20 项查看；有冲突或未完成扫描时先处理问题，再重新扫描。确认复制前先退出使用该存档的游戏。内容或目录变化会使旧确认失效。

任务页分别显示手机与电脑的发送/接收阶段、实际字节和文件计数。手机发送完后，若电脑仍在写入，页面继续查询同一个任务；目标成功取决于接收端回读结果。失败、部分完成、取消、结果待确认及清理错误分别展示，可重读状态、重试清理或重新扫描当前目录。

“备份与恢复”显示本机保存位置、覆盖前备份开关、有效轮次和未完成残留。关闭开关先确认；清除应用数据或卸载应用会丢失私有备份。选择轮次后先核对备份和当前内容，预览并确认恢复；恢复始终另存将被覆盖的当前内容，普通复制的备份开关不影响这项保护。

`src/platform/sync-adapter.ts` 的 `createMobileSyncAdapter(library, dependencies?)` 负责从持久配置与最新目录表固定项目绑定，在通知授权后再次复核；本机恢复也会在执行前核对保存的项目根。方法失败抛 `Error`；调用方提供确认和错误显示。Native 只接收公开 ID 和完整固定计划，文件流留在原生。

`useSyncTasks` 在应用内持续查询复制和恢复所有者，切换页面不取消任务；网页卸载只停止自己的轮询。`currentCopy/currentRestore` 恢复本进程任务上下文，`prepare/execute` 与 `prepareRestore/executeRestore` 分开，查询和清理都不自动调用执行。原生备份设置及显式维护与传输、恢复使用同一个目标名额，实际任务未清理完成时拒绝修改。

## 系统明暗主题

页面首次挂载前读取 `prefers-color-scheme`，通过 antd-mobile 的 `data-prefers-color-scheme` 属性切换完整主题，并监听运行时变化；热更新时释放旧监听。按用户要求，移动端暗色页面、启动及原生窗口背景统一为纯黑 `#000000`；文字和空状态说明使用组件库的明暗语义色，浏览器原生控件随主题切换。

Android 使用日夜主题及 `values`/`values-night` 的窗口/启动背景，WebView 为透明底色；运行中以 MainActivity 的 `savedata:theme-change` 原生通知（仅含 `dark: boolean`）为准修正 WebView 缓存的媒体查询，并用 Capacitor 内置 `SystemBars` 显式同步系统栏图标颜色。媒体与原生事件监听均可清理。应用自行渲染暗色，关闭原生自动反色。当前没有手动开关或持久化主题偏好。

## 应用图标

Android 的 `drawable-nodpi/app_logo.png` 与仓库根目录 `assets/app-logo.png` 使用同一份用户 PNG。Manifest 的 icon、roundIcon 和系统启动画面直接引用该图片，保留原有透明背景，不额外留白或预裁圆形；具体显示形状由系统和启动器决定。既有启动画布使用同源图片。

应用页面保留文字标识，按用户要求不在安卓页面增加 logo。

## 原生边界

`android/app/src/main/java/io/github/galgame/savedatasync/` 中：

- `SafDirectoriesPlugin` 注册系统目录选择器，后台线程串行访问提供者；不检查 Activity 可见性，不在暂停时取消查询，销毁时释放桥执行器。选择器需要系统确认，只请求并持久化 READ；不使用 root。
- `SafDirectoryStore` 独立持久化 schema 1、安装内 deviceId、根 rootId/URI/显示名。配置损坏或版本未知时失败，不重建覆盖。文件清单、文件哈希和 entryId 不持久化。
- 当前层查询不扫描后代；目录 sizeBytes=null，未知文件大小=null，空文件=0。SAF 日期 0 表示未知，映射 null；超出 JS 安全范围的数字拒绝。写入、新建、重命名、删除能力均为 unsupported；未知提供者能力保持 unknown。
- `openFile(rootId, entryId, signal)` 仅供同包原生代码使用：重查授权、文件类型和已观察到的名称/大小/日期，以 `r` 打开 `InputStream`。调用者拥有并必须关闭流；取消在读取时检查，未来传输生命周期所有者还必须关闭阻塞流。异常为 `SafFailure`，原始 cause 仅留原生层，JS 仅见脱敏码/消息。

URI 与 documentId 不转换为文件系统路径；文件内容不进入 JavaScript/Base64。文件 ID 由提供者维护；属性检查能发现可观察变化，恶意并发修改下的原子内容快照由传输层按实际字节/哈希校验。原生新文件发布使用下述独立入口；HTTP 传输已通过独立原生任务桥连接，只读桥保持三个方法。

## 原生归档接口

WP-013 的同包 Java 接口由后台 I/O 线程调用，不向 JS 暴露文件流或私有路径：

```java
// 源必须来自当前 SafDirectoryStore 已枚举的文件，rootId 与本次源根一致。
ArchiveAdapter adapter = SafArchiveSource.createAdapter(context);
ArchiveControl control = new ArchiveControl();
List<ArchiveModel.Source> sources = Collections.singletonList(new SafArchiveSource(store, rootId, entryId));
try (ArchiveAdapter.Artifact prepared = adapter.prepare(transferId, deviceId, rootId, sources, control, null)) {
    ArchiveModel.Manifest manifest = prepared.manifest;
    try (InputStream archive = prepared.openArchive()) {
        // 原生调用者以有限缓冲消费归档；这里不执行网络或目标发布。
    }
}
```

- `prepare` 按流暂存只读源、实测未知长度并计算 SHA-256，读取前后重新核实 SAF 授权、文档身份和已枚举的名称/大小/日期；可观察变化返回 `source-changed`。之后仅从私有快照构造规范 USTAR 和 gzip level 1。源显示名保留在清单，tar 仅含连续 fileId，支持不同已有目录中的同名源。
- `receive(manifest, input, control, progress)` 接管并关闭输入。先完整暂存并核对压缩体长度/SHA-256，再严格检查单 gzip member、DEFLATE 结束、CRC32/ISIZE、全部 USTAR 字段/顺序/零填充/精确结束和每份原文长度/SHA-256；全部通过才返回私有句柄。拒绝拼接、尾随、扩展、链接和路径。输入为固定 v1 原生不可变模型；JSON/版本/封闭字段解析由独立 TransferJson/TransferSchema 负责。
- `Artifact.manifest` 及其文件数组不可变；`openArchive`/`openFile(fileId)` 返回调用者负责关闭的只读流，fileId 必须属于该清单。关闭全部流后调用 `close()`（即 dispose）；句柄随后失效。源、归档和解包均显式使用至多 64 KiB 缓冲，逐文件处理。
- `ArchiveModel.Limits` 固定上限为 1024 文件、单项 256 MiB、原文合计 1 GiB、tar 1 GiB+1 MiB、压缩体 1088 MiB、实际私有缓存合计 3 GiB；测试注入只能收紧。声明、实际读取/解压/写入均计数；空间预检通过后仍可能遇到写入失败，按实际错误处理。
- 每次下载在打开 HTTP 内容流前检查“压缩体 + 解包原文”的缓存空间，并查询 SAF 提供者能报告的目标余量、对照整批原文总量。容量不足返回 `insufficient-space`；容量未知时保留未知，实际写入前继续通过文件描述符检查。空间预检不创建目标文件，也不预留磁盘。
- `ArchiveControl` 在每次 I/O、解压和进度检查取消、线程中断及不刷新的 30 分钟总期限；`cancel()` 可从生命周期线程调用，会关闭已登记的读流并取消 SAF 查询。外层任务所有者负责在期限到达或用户显式取消时主动 cancel 以唤醒阻塞的提供者；切后台继续已有传输，不因此取消，再等待工作线程清理；本模块不创建后台服务或恢复旧任务。
- `ArchiveCache` 仅在可信 Context 的真实私有缓存路径创建 `transfer-archives-v1`，根/随机任务都有所有权标记，拒绝其下链接/未知条目。每个进程只允许一个任务，句柄和清理失败均占名额。重启只清除可验证的孤儿缓存；不恢复旧结果。`ArchiveCache.retryOrphanCleanup()` 只重试已核实的启动孤儿，不关闭活动任务。
- `ArchiveFailure.code` 为稳定错误码，原始 cause 仅留原生层；取消以 `cancelled=true` 区分，清理失败保留主错误并放入 `cleanupFailure`。关闭读流后可调用 `adapter.retryCleanup()`；已经确认成功的内容校验保持成功，清理结果单独记录。回调在同一 I/O 线程接收阶段、实际字节数及可空总量，未知长度不计算百分比。

该包已完成实际 API 33 SAF 读流集成与设备验收；原生目标发布可直接消费 `Artifact.openFile`，HTTP 与通知保持传输由 WP-006 提供。

## 原生新文件发布

同包 `NewFilePublisher`/`SafPublicationBackend` 供可信原生 I/O 工作线程调用。系统 WRITE 权限与本次进程显式写授权分别检查；读取登记和 HTTP 接收能力不会顺带获得发布权限。调用方先通过真实系统选择器取得目标根的持久 READ/WRITE，再显式 `grant(rootId)`；当前只授权独立合成目标，真实存档保持只读。

```java
NewFilePublisher publisher = new NewFilePublisher(new SafPublicationBackend(context, store));
publisher.grant(targetRootId); // 可信原生用户动作，不接受网络自行授权。
PublicationModel.Request request = new PublicationModel.Request(
    file.fileId, targetRootId, targetParentId, newName, file.sizeBytes, file.sha256);
publisher.preflight(request, control); // 只读检查，不创建文件或目录。
PublicationModel.Result result = publisher.publish(request,
    () -> verifiedArchive.openFile(file.fileId), progress, control);
// PublicationJson.result(result) 输出 outcome、cleanupStatus、cleanupError，供后续批次聚合。
```

- `parentId` 必须来自同一根当前实例已枚举的已有目录，null 表示根层；发布流程不创建目录。每次重新核实系统授权、目录身份/名称/类型及新建能力。请求校验不透明 ID、单文件名、小写 SHA-256 和非负长度；单项上限 256 MiB，当前层最多 32768 条，实际流缓冲 64 KiB。
- 创建前拒绝已存在的同名及常见 NFC/大小写等价名称，不改写输入名。调用 `createDocument` 后重新枚举，只有返回 ID 不在创建前集合、确实位于指定父目录、实际名精确匹配且无名称竞争时才写入。自动改名或竞争失败只清理已知新建条目；返回已有 ID、空/未知回执或归属无法确认时返回 unknown，不猜测删除或重放。
- 后端只支持可确认为常规文件的描述符。先保持新空文件的只读描述符作为设备/inode 身份基线，再用不截断的 `rw` 打开并比对身份/空长度，之后才写入；不使用覆盖或重命名原语。空间预检通过后仍要处理实际 IO、ENOSPC 和 EDQUOT。
- 按实际长度/EOF/SHA-256 校验输入，关闭并同步输出，再重新打开实际目标回读完整内容，同时前后核实身份、名称、父目录、长度和可观察修改时间；完成后才报告 succeeded。成功确认之后的取消或句柄清理失败不删除最终文件。
- 失败/取消只删除本次已知新建且身份仍匹配的条目，清理结果与发布结果分开。所有输入/输出/回读流均由发布器接管并关闭；关闭或删除失败保留资源和进程发布名额，`retryCleanup()` 仅重试清理。归档与发布使用独立名额，可边持有已验证归档边发布其私有原文流。
- `cancel()`/`revoke(rootId)` 关闭已登记流和查询信号；无法中断的系统创建必须等待回执后确认归属。`stop()` 撤销进程授权并请求取消，活动调用未返回时为 false；生命周期所有者须等待工作线程，再确认停止/清理。复用 `ArchiveControl` 的绝对期限，外层所有者负责期限或用户显式取消时主动 cancel 唤醒阻塞 IO；Activity 暂停不取消活动传输。
- `PublicationJson` 对齐共享 `FileOutcome`/`BatchCleanup`；错误会脱敏，重试只按用户新操作进行。HTTP、整批验证、历史恢复和 UI 由批次调用者负责；发布前先完整验证全部归档原文。

SAF 没有通用排他创建或比较后删除原语；这些复核能发现可观察竞争，恶意提供者或并发命名空间变更不在原子隔离范围内。身份未知时拒绝写入和删除；无法验证常规描述符身份的提供者会停止发布。平台依据见 [DocumentsContract](https://developer.android.com/reference/android/provider/DocumentsContract) 和 [ContentResolver.openFileDescriptor](https://developer.android.com/reference/android/content/ContentResolver#openFileDescriptor(android.net.Uri,java.lang.String,android.os.CancellationSignal))。

## 原生 HTTP 与持续通知

`src/platform/http-transfers.ts` 导出 `androidTransfers`，已接入 WP-007 界面。文件字节只经过 Java 原生流，JS 接收目录、清单、句柄和实际任务状态；网页预览不发起原生操作。

下载在清单准备前取消或失败，也会生成本地接收终态，全部文件标为“未尝试”。桥在缺少清单时只接受与本次文件 ID、顺序和失败/取消原因精确匹配的该类结果；已写入结果继续要求完整清单、哈希及目标匹配。刷新结果保留已取得的终态，查询失败另行提示；电脑清理失败须到桌面重试。

| 方法 | 行为与边界 |
| --- | --- |
| requestNotifications / chooseTarget | 主动申请通知权限，并通过真实 SAF 选择器取得本次目标 WRITE；目标选择取消保留原有根，不接受 URI 或任意路径参数；应用不设置前后台门禁，系统实际错误按调用结果返回 |
| connect / disconnect | 明确连接手动数字 IP 的 HTTP 地址，核实 v1、Windows 设备/会话/固定预算；不自动重放旧任务；活动传输或清理期间拒绝切换连接 |
| listRemoteRoots / listRemoteDirectory | 校验设备身份、根/父层及唯一条目，仅读取当前层；源必须是本次已列出的文件 |
| startDownload / startUpload | 参数为 request（连续 fileId 与源引用）、targetRootId、targets（已有父目录和单文件名）；原子占用本地单次 ID 与进程名额后返回 transferId，I/O 异步执行 |
| query / queryRemote / getManifest | 分开本机与对端角色，清单和状态核对本次任务/源/目标/哈希；下行清单尚在远端准备时 query 可返回 task-conflict，可用 queryRemote 查看 sender；不重发 POST/PUT |
| current / subscribe | Activity 重建后 current 取得同一任务的选项/角色/设备上下文，再查询实际状态；不会新建或重放任务。订阅顺序处理，不以可见性过滤通知；订阅者负责 remove，异常不改变任务结果 |
| cancel / retryCleanup | 用户显式取消关闭本地流并尽力请求远端 DELETE；清理只重试资源释放，不重放传输。清理失败保持互斥名额及通知，可从通知重试 |

`TransferJson` 严格拒绝重复键、坏 UTF-8、未配对代理项、附加内容、超限深度/节点及非安全整数。JSON 单项 8 MiB，原文不经内存整批收集。`TransferSchema` 独立核实封闭字段、清单/目标/角色/实际结果、完整顺序和单调进度；跨桥还有共享守卫及上下文匹配。

`TransferHttp.Client` 使用无代理的 HttpURLConnection，明确 identity，并关闭自动解压、重定向和缓存；控制体和 gzip 体分别限额。压缩体必须匹配唯一 Content-Length/SHA-256，歧义定界和 Content-Encoding 会被拒绝。显式缓冲 64 KiB，传输绝对总期限 30 分钟、连接和默认网络无进展等待 5 秒，初次 connect 握手总期限 5 秒；使用固定长度发送。连接失败以短时消息显示原始 HTTP 状态、协议错误码或系统 errno/异常类型。首次 catalog 请求携带 x-sync-connect: 1，表示主动建立新连接；普通轮询不携带。POST/PUT 丢失回执时只查询同 ID，不重发。取消线程断开连接，原 I/O 线程关闭网络缓冲流，避免 Android Okio 与 read 并发 close。

上行复用原生源快照/归档，先核实 Windows awaiting-content 再唯一 PUT，手机仅报告 sender sent，继续核实独立 Windows receiver 结果。下行核实来源和全部本地目标后才 GET content，完整压缩体/全部原文通过前不创建 SAF 文件；首次发布失败停止后项，成功、失败/取消/未知及未尝试分别报告。已确认成功不因晚取消或清理失败回滚。

`TransferRuntime` 使用应用 Context 持有任务与原生适配器，Activity 仅弱订阅，不拥有传输生命周期。用户发起任务前先确认 `TransferService` 的 dataSync 前台服务和持续通知已启动；Android 13+ 需通知权限。Activity 暂停、销毁或回到桌面后，原任务继续运行；完成/显式取消并清理后服务和通知结束。通知展示阶段/进度，提供显式取消或残留清理重试，点击可回到应用查询原任务。

声明 FOREGROUND_SERVICE、FOREGROUND_SERVICE_DATA_SYNC、POST_NOTIFICATIONS；服务不导出、START_NOT_STICKY，没有开机接收器、定时同步或旧任务恢复。系统结束服务或进程后，任务不会记成成功，也不会自动重放。已有终态/清单保留 10 分钟，本地最多保留 32 份结果，进程最多 4096 个已用 ID；到期仍保留 ID 防重记录。实际支持的目录和系统/提供者能力以调用结果为准。

Android 行为依据见 [dataSync 前台服务](https://developer.android.com/develop/background-work/services/fgs/service-types)、[通知权限](https://developer.android.com/develop/ui/compose/notifications/notification-permission)及 [HttpURLConnection](https://developer.android.com/reference/java/net/HttpURLConnection)。

`SyncScanner` 提供当前 SAF 递归扫描、原生 SHA-256、空目录及失败部分结果，复用 `SafArchiveSource` 的权限/身份/属性前后复核。扫描按普通本地操作执行，不加保活或前后台处理。`SyncScansPlugin` 只提供 capabilities/start/query/cancel，参数为 schemaVersion/rootId 或 scanId；没有 URI、平台路径、文件内容及可调预算。结果与 Windows 使用同一 SyncScanState，期限、条目/深度/JSON 限制和 32 份结果保留沿用 [M-002 文档](../../docs/plans/m002-sync-copy.md) 第 3 节。

`src/platform/sync-scan-bridge.ts` 核对有限参数、完整结果及 rootId/scanId 上下文；`androidSyncScans` 为平台接入。所有调用返回 OperationResult；query 的成功包络只代表查到任务，扫描是否成功取决于内部 status。显式取消会关闭原生读流和 SAF 查询；未知长度按流实测，源变化和授权失效返回具体错误。扫描、备份和受保护写入已提供原生入口；双向复制编排见下节，界面继续按工作包接入。

## 独立备份与恢复材料

`SafRuntime.backups(context)` 在 `Context.getFilesDir()/backups/` 初始化持久备份；源文件通过已有 SAF 授权读取。备份位置属于应用私有存储，不再弹目录选择器。清除应用数据、卸载或手工删除备份区会丢失其中的材料。

| 原生接口 | 输入、输出与资源责任 |
| --- | --- |
| `BackupStore.create(projectId, rootId, reason, shouldBackup, entries, control)` | 原生编排器传入确认计划中全部 replace-file 对应的目标 SyncEntry 文件项；按原相对路径复核本次引用，返回 `{ manifest, cleanupError }`；关闭备份或没有覆盖时 manifest 为 null，reason=restore 强制开启保护 |
| `list` / `manifest` | 按项目/根返回轮次摘要和未完成 ID，或按 backupId 取得单轮清单；清单显示与实际文件复核分开，恢复前必须 acquire |
| `settings` / `setPreference` / `capacity` | 独立 SyncBackupSettings，缺少项目设置时使用 true，坏文件保持原样；容量在完整新轮与旧轮共存时预检，未知值为 null，不足返回 insufficient-space |
| `acquire(projectId, rootId, backupId, control)` | 重新核对全部原文后返回 Handle；manifest 为副本，snapshot 是本次恢复树，source(fileId) 提供原生只读流与身份观察；消费者先关闭流，再 release，引用期间不淘汰该轮 |
| `rotate` / `cleanupIncomplete` | 明确重试轮换或清理归属已核实的未提交/已淘汰轮次；有效轮次和被恢复引用的材料不会按残留删除 |
| `close` | 原生所有者关闭存储时取消当前操作、等待文件释放并关闭读取引用；已提交备份持久保留 |

`BackupModel` 与共享备份 v1 清单一致。每个旧文件先校验源属性、流式大小/SHA-256，再同步落盘并独立读回；全部完成后原子提交清单。每个项目/根保留最近 3 次，新轮提交后才轮换，轮换失败单独报告。读取未知长度时按流实测并核对计划的大小与哈希，文件内容不经过 JS。取消、期限或实际失败在提交前结束时不产生有效轮次，清理错误附在主错误之外。预算、位置和恢复规则统一见 [M-002 文档](../../docs/plans/m002-sync-copy.md) 第 3 节。

`BackupFiles` 只访问已核实的私有普通文件，Android 实际身份和链接数由 `Os.lstat` 读取；固定 fileId、所有权记录、根/轮次身份和前后属性共同约束访问与清理。未提交轮次重启后通过明确操作清理，既不恢复旧同步，也不按文件名前缀猜测用户文件归属。

`src/platform/backups.ts` 导出 `androidBackups`，只提供 read/list/manifest/setPreference/rotate/cleanupIncomplete。参数只有公开 ID 和布尔开关，read 的 displayPath 仅供展示；Java 和 TS 分别校验封闭字段、清单及本次上下文，控制 JSON 仍限 8 MiB。创建、原生句柄和文件内容不跨这个桥；实际目标写回由 `SyncWriter` 提供，本机恢复使用独立的 `SyncWrites` 桥，界面由 WP-028 接入。

## 受保护写入与本机恢复

`SyncPlanModel` 从两端完整快照重新推导全部动作、顺序、条目引用和预算；原生执行只接受完整可执行计划。`SyncWriter.apply(plan, material, control)` 供原生复制编排和本机恢复使用，目标必须为本机，方向为 windows-to-android 或 local-restore。material 提供与源快照匹配、可重复读取的原生 Source，调用期间保持其有效；writer 消费并关闭输入流。非法/过期/重复确认或 busy 抛异常，接纳后返回完整 `SyncApplyResult`，逐项成功、失败、取消、未知和未执行分开表示。

写入前以任务自身控制器重扫目标，完整读取本批输入并核对指纹；备份开启时先提交所有将被覆盖的旧内容。Android 原地覆盖按文件增量预检目标空间，并合计已知同卷的备份峰值；备份落盘后再查目标实际余量，覆盖 SAF 与私有区逻辑设备 ID 不同但共用物理空间的情况。未知余量保持 null，实际读写失败仍返回具体结果。

`SafSyncBackend` 沿用已授权树和父目录引用。创建目录后核实文档 ID、类型、原始名称及父目录，创建竞争或不明回执不会报告成功；新文件复用已有非覆盖发布器。覆盖使用 `r` / `rw` 常规 FD，比较设备/inode、链接数、文档 ID、父目录、日期及旧内容；拒绝虚拟文档、额外硬链接和无法核实的文件。`rw` 打开保留旧内容，完整写入后才设置最终长度、fsync 并独立回读长度/SHA-256。

第一项失败、取消或未知后停止后项，已确认成功的文件和目录保留，目标独有条目保持原样。写入中断后目标可能已有部分修改，此时返回 unknown/result-unknown，旧内容仍可从有效备份读取。晚取消与提交竞争时按实际回读结果报告。清理错误独立保存，清理未完成保持 `TargetOperation` 名额；旧传输、新复制和本机恢复共用该进程互斥。总期限 30 分钟，显式控制和读写缓冲沿用 64 KiB 预算；普通本机操作不增加前后台判断或保活服务。

`SyncWriteRuntime` 由应用 Context 持有，`SafRuntime.writes(context)` 取得同一实例；Activity 重建后按 restoreId 查询，插件销毁只关闭自己的控制线程。最多保留 32 份预览/结果，预览和终态保留 10 分钟；到期释放输入材料，不重放任务。原生所有者显式 close 才取消并等待运行中的恢复、释放资源及计时线程。

| `SyncWrites` / `androidSyncWrites` 方法 | 输入、输出及资源责任 |
| --- | --- |
| `bindProject(projectId, rootId)` | 平台层先核对已保存的游戏配置，再绑定已有授权根；原生重新检查持久写权限，活动任务/清理期间拒绝改绑。绑定只存本进程，配置或会话改变后由平台层重新核实 |
| `prepareRestore(projectId, rootId, backupId)` | 返回 preparing 状态和新 restoreId；工作线程完整验证备份并保持引用，重扫当前目标后进入 ready。本机恢复强制为当前覆盖内容另建保护备份 |
| `preview(restoreId)` | 单独取得固定的源/目标快照；TS 生成同一 planId 的本机恢复计划，可显示冲突。预览与结果分开查询，控制 JSON 各限 8 MiB |
| `execute(restoreId, plan)` | 核对项目/根、原生固定预览及完整计划，再执行一次；ready/终态与活动名额同时提交，重复执行返回 task-conflict |
| `query(restoreId)` / `cancel(restoreId)` | 查询本机状态与实际结果，或显式取消；查询不延长期限，返回 HTTP/桥成功包络只表示调用成功，恢复是否成功取决于内部状态和结果 |
| `current()` | 返回本进程活动恢复或最近记录的 restoreId，没有记录时为 null；用于页面重建后取回同一预览和结果，不启动恢复 |
| `release(restoreId)` / `retryCleanup()` | 放弃预览或释放终态数据，明确重试未释放资源；运行中的任务先取消并等待终态，清理操作不重放文件写入 |

`src/platform/sync-write-bridge.ts` 校验封闭字段、ID 上下文、预览计划与逐项实际结果；新页面实例可重新取回原生预览来核对终态。原生材料、URI、路径和文件字节不跨桥。恢复页面通过有限平台适配器接入；清理失败的记录保留到明确释放完成，重试清理后更新其清理状态。旧 v1 非覆盖入口保持原行为。

```ts
// game 来自已保存并核实的本机配置；文件内容和句柄始终留在原生层。
unwrap(await androidSyncWrites.bindProject(game.id, game.rootId))
const task = unwrap(await androidSyncWrites.prepareRestore(game.id, game.rootId, backupId))
// query 到 ready 后取得这份固定预览，交给用户确认。
const plan = unwrap(await androidSyncWrites.preview(task.restoreId))
const running = unwrap(await androidSyncWrites.execute(task.restoreId, plan))
// 继续 query 实际终态；不用此预览时 release，清理失败时明确 retryCleanup。
```

## 双向复制编排

`SyncTransferRuntime` 由应用 Context 持有 `SyncTransferEngine`；复用同一原生连接和归档缓存。`SyncJobModel` 核对目录表中的双向项目关联、当前快照、源清单和 receiver 的完整逐项结果。`SyncPlanModel` 支持两种复制方向，实际 `SyncWriter` 仍只接受本机目标。新增协议集中在 [M-002 文档第 3.6/3.7 节](../../docs/plans/m002-sync-copy.md#36-http-与本地桥)。

| `SyncTransfers` / `androidSyncTransfers` 方法 | 输入、输出与资源责任 |
| --- | --- |
| `prepare(binding, direction)`、`queryPreparation(id)`、`preview(id)`、`cancelPreparation(id)` | 方向为 android-to-windows 或 windows-to-android；固定已保存配置发布的项目/设备/根，普通扫描生成异步准备状态，预览分别返回两份快照及目标备份开关。预览可展示冲突，准备阶段不占传输名额或启动保活 |
| `execute(preparationId, plan)` | 原生核对同次预览与完整可执行计划，消费一次确认并取得进程名额；系统接受传输通知后才登记远端任务并上传或下载归档。启动失败保留可查询的失败结果，重复执行拒绝 |
| `query(jobId, shouldRefresh?)`、`manifest(jobId)`、`current()` | 分别读取两个角色的状态、仅公开元数据的清单、最近任务 ID；页面重建可按 ID 取回预览重新校验。refresh 只查询原远端任务，不续期、不重放；运行期间由原生 worker 查询实际进展 |
| `cancel(jobId)`、`release(preparationId)`、`retryCleanup()` | 显式取消并读取 receiver 实际结果，释放已结束的预览/任务，或重试本进程仍持有的缓存清理。清理失败保留名额和通知，重试只释放资源，不重复写入 |

确认后先登记目标任务，再从实际 SAF 流准备源归档，逐文件核对引用、原名、父目录、修改时间、大小和 SHA-256；清单及内容各提交一次。源读取和归档期间每 3 秒查询原任务作为通信心跳，持续通信中的设备保持在线。登记、清单或内容回执丢失时查询同一 ID，查询失败记为待确认。sender sent 只表示已发送，最终是否成功以 receiver 的实际 `SyncApplyResult` 为准；重新查到电脑仍在写入时继续等待同一任务。无文件的计划不生成空归档。

Windows → Android 使用手机目标项目的备份设置；Windows 原生重新核实源目录并准备不可变归档，ready 后手机核对清单与确认计划，再检查缓存、备份和目标增量的已知同卷峰值。内容 GET 只领取一次；完整压缩体及全部原文通过校验后，`SyncWriter` 借用本次原生名额和确认时间，重新扫描目标、提交保护备份并逐项写入。手机独立报告实际结果；发送端末次查询失败不会抹掉手机已核实的成功，也不重取内容。只有目录或无需写入时直接执行无内容分支。私有备份创建遗留或轮换失败由本实例保留引用，显式清理只重试自己的资源。

普通准备不判断应用前后台。确认执行后才使用 dataSync 服务和持续通知，覆盖源归档、上传/下载、校验、备份/写入、等待电脑结果及清理；插件销毁不会中断应用级启动或任务。原生源缓存发送完成后释放，名额保留到 receiver 结果或明确的待确认状态及本机清理完成。目标端本机处理期间继续查询原任务维持通信；心跳不重放内容或延长任务期限。任务总期限 30 分钟，预览/终态最多保留 10 分钟、各最多 32 份，已用任务 ID 最多 4096 个并保留到进程结束。源权限失效、内容变化、版本/能力不兼容及空间不足有明确错误，业务不按前后台决定成败。

`src/platform/sync-transfer-bridge.ts` 对 Native 返回值再次核对计划、清单、计数、角色和完整结果；新桥实例可从原生恢复同次上下文。平台层先核实保存的配置并取得通知权限，再调用这个有限 API；手机复制、备份及任务页面已通过平台适配器接入。

```ts
// binding 来自刚核实的本机配置和已连接目录表，不接受文件路径。
const preparing = unwrap(await androidSyncTransfers.prepare(binding, 'android-to-windows'))
// queryPreparation 到 ready 后显示本次预览和比较计划，确认后执行一次。
const preview = unwrap(await androidSyncTransfers.preview(preparing.preparationId))
const plan = syncPlanFromPreview(preview)
const running = unwrap(await androidSyncTransfers.execute(preparing.preparationId, plan))
// query 同一 jobId 的两个角色；current/preview 用于页面重建，不能自动调用 execute。
```

## 验证

- `pnpm test:mobile`：运行最小 TS 桥检查，只验证请求/响应边界、结果上下文和订阅清理，不纳入 `pnpm check`。
- `pnpm android:test`：同步 Web 工程，生成 Windows 原生归档供 Java 消费，执行 Java 单元测试、Android lint、调试与仪器测试 APK 构建，最后验证 Windows/JVM 归档互通。不连接设备。
- `pnpm test:all`：依次运行基础设施、共享、桌面、移动桥及 Android 原生测试，用于发布或大范围高风险改动。
- 设备测试只保留 3 项：1 项 SAF 选择与只读读取，1 项固定归档互通，1 项实际 SAF 两轮快照。界面主题、按钮和具体文案由实际运行与截图验收。
- 安装两个调试 APK 后，`adb shell am instrument -w -e class io.github.galgame.savedatasync.ArchiveSafTest#androidConsumesPythonAndWindowsNativeArchivesAndExportsJavaArchive io.github.galgame.savedatasync.test/androidx.test.runner.AndroidJUnitRunner` 验证跨端归档固定夹具。
- SAF 读取先准备 `SaveDataSync-Archive-<随机后缀>` 合成目录，再以 `-e safMode select -e safExpectedName <显示名> -e class io.github.galgame.savedatasync.SafDirectoriesTest#pickerSelectionAndNativeRead` 运行，由用户在系统选择器中授权。测试只输出条目和文件计数。
- 同一合成目录随后以 `-e archiveExpectedName <显示名> -e class io.github.galgame.savedatasync.ArchiveSafTest#actualSafStreamsSnapshotKnownAndUnknownLengthsWithoutChangingSource` 运行，验证已知/未知长度的两轮快照。缺少授权或夹具时直接失败。
- `scripts/verify-archive-interop.mjs prepare|verify` 已纳入 `pnpm android:test`。设备生成的 `cache/archive-device-java.gz` 可取回 `.reports/wp013-device/java.gz`，再运行 `node --experimental-strip-types scripts/verify-archive-interop.mjs verify-device`，由 Windows 原生解包器复核设备产物。
- 实际 SAF 专项另外输出私有 `cache/archive-device-saf.gz` 与 `cache/archive-device-saf.json`；二进制取回到 `.reports/wp013-device/saf.gz`、`saf-manifest.json`，保留原本四份上传合成源为 `empty.sav`、`unicode.sav`、`large.sav`、`control.sav` 后，`verify-device-saf` 模式用 Windows 原生接收器逐项核对原文。设备报告副本验证后可删除，受管理归档任务在每项测试结束时已清理。

WP-006 的 API 33 实测通过 ADB 开发者控制台操作正式原生桥，文件数据走真实 LAN HTTP，调试通道不承载传输体。双向各 3 文件（空/UTF-8/131073 字节）及 2 轮后台 1 MiB 接收，共 8 份输出与原文逐字节一致；6 份原生/远端状态及 10 份进度快照通过共享守卫匹配。返回桌面后持续通知/dataSync 服务仍在，Activity 重建后 current 可取回同一任务，后台完成后通知和服务结束；显式取消没有目标残留，私有缓存只留下根所有权。两端原文件的内容、大小、mtime 和身份保持不变，测试目录权限与临时服务均已回收。通知截图及原始回执只保留在忽略的本地报告中。

真实存档保持只读。损坏配置和失效权限夹具使用独立的应用私有配置，不改真实根授权。Android 10 及较新系统、SAF、正式 LAN HTTP、通知保持传输和独立界面已通过真机验收；空文件/中文名双向内容、子目录刷新后传输、准备前取消、同名冲突、页面重载与 64 MiB 后台上传已核对 SHA-256。满额 1 GiB 双向往返、进程内存及每次传输容量预检见[规模验收](../../docs/validation/m001-resources.md)。
