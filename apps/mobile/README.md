# Android 目录、原生传输与持续通知

## 目录

- [界面入口](#界面入口)
- [系统明暗主题](#系统明暗主题)
- [原生边界](#原生边界)
- [原生归档接口](#原生归档接口)
- [原生新文件发布](#原生新文件发布)
- [原生 HTTP 与持续通知](#原生-http-与持续通知)
- [验证](#验证)

## 界面入口

`src/saf-directories.ts` 导出 `androidDirectories`，只提供三个异步方法：

```ts
import { androidDirectories } from './src/saf-directories'

const selected = await androidDirectories.chooseDirectory()
if (selected.status === 'selected') {
  const listing = await androidDirectories.listDirectory(selected.directory.rootId)
  // 检查 status；成功空数组、未知属性 null 和错误是不同结果。
}
const roots = await androidDirectories.listRoots()
```

`chooseDirectory()` 返回共享 `DirectorySelectionResult`；取消保留既有目录。`listRoots()` 返回 `OperationResult<readonly DirectoryReference[]>`；保存的引用失去权限时仍存在，authorization 为 expired。`listDirectory(rootId, parentId = null)` 返回当前层 `OperationResult<DirectoryListing>`，parentId 只能来自当前原生会话枚举出的目录条目。重建进程后先重新列目录，不复用旧 entryId；同一进程的目录桥和传输模块通过 SafRuntime 共享当前引用。

TS 桥校验请求与响应，拒绝路径/URI、附加字段及跨根/跨层响应；原生插件也独立校验请求。未安装插件、畸形返回和连接异常转为脱敏错误。网页预览返回 unsupported-operation。当前空壳尚未接入这些按钮，最终界面由后续工作包完成。

## 系统明暗主题

页面首次挂载前读取 `prefers-color-scheme`，通过 antd-mobile 的 `data-prefers-color-scheme` 属性切换完整主题，并监听运行时变化；热更新时释放旧监听。按用户要求，移动端暗色页面、启动及原生窗口背景统一为纯黑 `#000000`；文字和空状态说明使用组件库的明暗语义色，浏览器原生控件随主题切换。

Android 使用日夜主题及 `values`/`values-night` 的窗口/启动背景，WebView 为透明底色；运行中以 MainActivity 的 `savedata:theme-change` 原生通知（仅含 `dark: boolean`）为准修正 WebView 缓存的媒体查询，并用 Capacitor 内置 `SystemBars` 显式同步系统栏图标颜色。媒体与原生事件监听均可清理。应用自行渲染暗色，关闭原生自动反色。当前没有手动开关或持久化主题偏好。

`ThemeTest` 通过应用局部的 AppCompat 日夜模式验证深色启动、浅色切换及再次深色：同时检查原生 uiMode、页面主题属性/color-scheme、页面/说明文字颜色、原生背景与状态栏/导航栏图标。结束后恢复应用原模式，不修改设备全局外观；通过单独指定该测试类在已解锁设备上运行。

## 原生边界

`android/app/src/main/java/io/github/galgame/savedatasync/` 中：

- `SafDirectoriesPlugin` 注册系统目录选择器，后台线程串行访问提供者；暂停时取消查询，销毁时关闭执行器。选择器需要系统确认，只请求并持久化 READ；不使用 root。
- `SafDirectoryStore` 独立持久化 schema 1、安装内 deviceId、根 rootId/URI/显示名。配置损坏或版本未知时失败，不重建覆盖。文件清单、文件哈希和 entryId 不持久化。
- 当前层查询不扫描后代；目录 sizeBytes=null，未知文件大小=null，空文件=0。SAF 日期 0 表示未知，映射 null；超出 JS 安全范围的数字拒绝。写入、新建、重命名、删除能力均为 unsupported；未知提供者能力不冒充支持。
- `openFile(rootId, entryId, signal)` 仅供同包原生代码使用：重查授权、文件类型和已观察到的名称/大小/日期，以 `r` 打开 `InputStream`。调用者拥有并必须关闭流；取消在读取时检查，未来传输生命周期所有者还必须关闭阻塞流。异常为 `SafFailure`，原始 cause 仅留原生层，JS 仅见脱敏码/消息。

URI 与 documentId 不转换为文件系统路径；文件内容不进入 JavaScript/Base64。文件 ID 由提供者维护；属性检查不能保证恶意并发修改下的原子内容快照，传输仍须校验实际字节/哈希。原生新文件发布使用下述独立入口；HTTP 传输已通过独立原生任务桥接入，最终界面尚未接入，只读桥保持三个方法。

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
- `ArchiveModel.Limits` 固定上限为 1024 文件、单项 256 MiB、原文合计 1 GiB、tar 1 GiB+1 MiB、压缩体 1088 MiB、实际私有缓存合计 3 GiB；测试注入只能收紧。声明、实际读取/解压/写入均计数，空间预检不代替实际失败处理。
- `ArchiveControl` 在每次 I/O、解压和进度检查取消、线程中断及不刷新的 30 分钟总期限；`cancel()` 可从生命周期线程调用，会关闭已登记的读流并取消 SAF 查询。外层任务所有者负责在期限到达或用户显式取消时主动 cancel 以唤醒阻塞的提供者；切后台继续已有传输，不因此取消，再等待工作线程清理；本模块不创建后台服务或恢复旧任务。
- `ArchiveCache` 仅在可信 Context 的真实私有缓存路径创建 `transfer-archives-v1`，根/随机任务都有所有权标记，拒绝其下链接/未知条目。每个进程只允许一个任务，句柄和清理失败均占名额。重启只清除可验证的孤儿缓存；不恢复旧结果。`ArchiveCache.retryOrphanCleanup()` 只重试已核实的启动孤儿，不关闭活动任务。
- `ArchiveFailure.code` 为稳定错误码，原始 cause 仅留原生层；取消以 `cancelled=true` 区分，清理失败保留主错误并放入 `cleanupFailure`。关闭读流后可调用 `adapter.retryCleanup()`；确认成功的内容校验不会被清理状态伪装成未发生。回调在同一 I/O 线程接收阶段、实际字节数及可空总量，未知长度不伪造百分比。

该包已完成实际 API 33 SAF 读流集成与设备验收；原生目标发布可直接消费 `Artifact.openFile`，HTTP 与通知保持传输已由 WP-006 接入。

## 原生新文件发布

同包 `NewFilePublisher`/`SafPublicationBackend` 供可信原生 I/O 工作线程调用。系统 WRITE 权限与本次进程显式写授权分别检查；读取登记、HTTP 接收能力和已存在的系统权限都不自动授予发布权限。调用方先通过真实系统选择器取得目标根的持久 READ/WRITE，再显式 `grant(rootId)`；当前仅授权独立合成目标，真实存档仍只读。

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

- `parentId` 只能来自同一根当前实例已枚举的已有目录，null 表示根层；不创建目录。每次重新核实系统授权、目录身份/名称/类型及新建能力。请求校验不透明 ID、单文件名、小写 SHA-256 和非负长度；单项上限 256 MiB，当前层最多 32768 条，实际流缓冲 64 KiB。
- 创建前拒绝已存在的同名及常见 NFC/大小写等价名称，不改写输入名。调用 `createDocument` 后重新枚举，只有返回 ID 不在创建前集合、确实位于指定父目录、实际名精确匹配且无名称竞争时才写入。自动改名或竞争失败只清理已知新建条目；返回已有 ID、空/未知回执或归属无法确认时返回 unknown，不猜测删除或重放。
- 后端只支持可确认为常规文件的描述符。先保持新空文件的只读描述符作为设备/inode 身份基线，再用不截断的 `rw` 打开并比对身份/空长度，之后才写入；不使用覆盖或重命名原语。空间预检不能代替实际 IO/ENOSPC/EDQUOT 处理。
- 按实际长度/EOF/SHA-256 校验输入，关闭并同步输出，再重新打开实际目标回读完整内容，同时前后核实身份、名称、父目录、长度和可观察修改时间；完成后才报告 succeeded。成功确认之后的取消或句柄清理失败不删除最终文件。
- 失败/取消只删除本次已知新建且身份仍匹配的条目，清理结果与发布结果分开。所有输入/输出/回读流均由发布器接管并关闭；关闭或删除失败保留资源和进程发布名额，`retryCleanup()` 仅重试清理。归档与发布使用独立名额，可边持有已验证归档边发布其私有原文流。
- `cancel()`/`revoke(rootId)` 关闭已登记流和查询信号；无法中断的系统创建必须等待回执后确认归属。`stop()` 撤销进程授权并请求取消，活动调用未返回时为 false；生命周期所有者须等待工作线程，再确认停止/清理。复用 `ArchiveControl` 的绝对期限，外层所有者负责期限或用户显式取消时主动 cancel 唤醒阻塞 IO；Activity 暂停不取消活动传输。
- `PublicationJson` 对齐共享 `FileOutcome`/`BatchCleanup`；错误脱敏且不授权自动重试。原生接口不承担 HTTP、整批验证、历史恢复或 UI；批次调用者必须先完整验证全部归档原文再调用发布。

SAF 没有通用排他创建或比较后删除原语；这些复核用于发现可观察竞争，不承诺对恶意提供者或并发命名空间变更的原子隔离。未知身份时拒绝写入/删除；不能验证常规描述符身份的提供者失败关闭。平台依据见 [DocumentsContract](https://developer.android.com/reference/android/provider/DocumentsContract) 和 [ContentResolver.openFileDescriptor](https://developer.android.com/reference/android/content/ContentResolver#openFileDescriptor(android.net.Uri,java.lang.String,android.os.CancellationSignal))。

## 原生 HTTP 与持续通知

`src/http-transfers.ts` 导出 `androidTransfers`。文件字节只经过 Java 原生流，JS 仅接收目录、清单、句柄和实际任务状态；网页预览不发起原生操作。最终界面由 WP-007 接入。

| 方法 | 行为与边界 |
| --- | --- |
| requestNotifications / chooseTarget | 可见界面主动申请通知权限，并通过真实 SAF 选择器取得本次目标 WRITE；目标选择取消保留原有根，不接受 URI 或任意路径参数 |
| connect / disconnect | 明确连接手动数字 IP 的 HTTP 地址，核实 v1、Windows 设备/会话/固定预算；不自动重放旧任务；活动传输或清理期间拒绝切换连接 |
| listRemoteRoots / listRemoteDirectory | 校验设备身份、根/父层及唯一条目，仅读取当前层；源必须是本次已列出的文件 |
| startDownload / startUpload | 参数为 request（连续 fileId 与源引用）、targetRootId、targets（已有父目录和单文件名）；原子占用本地单次 ID 与进程名额后返回 transferId，I/O 异步执行 |
| query / queryRemote / getManifest | 分开本机与对端角色，清单和状态核对本次任务/源/目标/哈希；下行清单尚在远端准备时 query 可返回 task-conflict，可用 queryRemote 查看 sender；不重发 POST/PUT |
| current / subscribe | Activity 重建后 current 取得同一任务的选项/角色/设备上下文，再查询实际状态；不会新建或重放任务。订阅仅通知当前可见界面，顺序处理；订阅者负责 remove，异常不改变任务结果 |
| cancel / retryCleanup | 用户显式取消关闭本地流并尽力请求远端 DELETE；清理只重试资源释放，不重放传输。清理失败保持互斥名额及通知，可从通知重试 |

`TransferJson` 严格拒绝重复键、坏 UTF-8、未配对代理项、附加内容、超限深度/节点及非安全整数。JSON 单项 8 MiB，原文不经内存整批收集。`TransferSchema` 独立核实封闭字段、清单/目标/角色/实际结果、完整顺序和单调进度；跨桥还有共享守卫及上下文匹配。

`TransferHttp.Client` 使用无代理的 HttpURLConnection，明确 identity、不自动解压/重定向、不缓存；控制体和 gzip 体分别限额。压缩体必须匹配唯一 Content-Length/SHA-256，拒绝歧义定界和 Content-Encoding。显式缓冲 64 KiB，绝对总期限 30 分钟、网络无进展 60 秒；固定长度发送，任何 POST/PUT 都不自动重发。登记或发送回执丢失只查询同 ID。取消线程断开连接，原 I/O 线程关闭网络缓冲流，避免 Android Okio 与 read 并发 close。

上行复用原生源快照/归档，先核实 Windows awaiting-content 再唯一 PUT，手机仅报告 sender sent，继续核实独立 Windows receiver 结果。下行核实来源和全部本地目标后才 GET content，完整压缩体/全部原文通过前不创建 SAF 文件；首次发布失败停止后项，成功、失败/取消/未知及未尝试分别报告。已确认成功不因晚取消或清理失败回滚。

`TransferRuntime` 使用应用 Context 持有任务与原生适配器，Activity 仅弱订阅，不拥有传输生命周期。用户发起任务前先确认 `TransferService` 的 dataSync 前台服务和持续通知已启动；Android 13+ 需通知权限。Activity 暂停、销毁或回到桌面后，原任务继续运行；完成/显式取消并清理后服务和通知结束。通知展示阶段/进度，提供显式取消或残留清理重试，点击可回到应用查询原任务。

声明 FOREGROUND_SERVICE、FOREGROUND_SERVICE_DATA_SYNC、POST_NOTIFICATIONS；服务不导出、START_NOT_STICKY，无开机接收器、定时同步或自动旧任务恢复。系统结束服务/进程时不伪造成功或重放。已有终态/清单保留 10 分钟，本地最多保留 32 份结果，进程最多 4096 个已用 ID；到期不释放 ID 防重记录。实际支持的目录和系统/提供者能力仍以调用核实为准。

Android 行为依据见 [dataSync 前台服务](https://developer.android.com/develop/background-work/services/fgs/service-types)、[通知权限](https://developer.android.com/develop/ui/compose/notifications/notification-permission)及 [HttpURLConnection](https://developer.android.com/reference/java/net/HttpURLConnection)。

## 验证

- `pnpm test:mobile`：既有 11 项 TS 桥检查，纳入 `pnpm check`。用户当前测试策略默认不新增或扩写自动化测试；功能验证优先 lint、编译、ADB 实操和截图。
- `pnpm android:test`：同步 Web 工程，生成 Windows 原生归档供 Java 消费，执行 Java 单元测试、Android lint，构建调试 APK 与仪器测试 APK，最后用 Windows 原生 receiver 解包 Java 产物；CI 同样执行，不自动连接设备。本包编排/网络测试在用户最新测试政策前已编写，此后未新增或扩写自动化测试。现共 77 项 Java 单元，其中 25 项归档、28 项发布、12 项编排、7 项真实 TCP/取消边界、4 项 SAF 及 1 项基础。
- 安装两个调试 APK 后，`adb shell am instrument -w io.github.galgame.savedatasync.test/androidx.test.runner.AndroidJUnitRunner` 执行独立私有夹具与原生桥参数验证。交互用例默认跳过。
- 对 `io.github.galgame.savedatasync.SafDirectoriesTest#pickerSelectionAndNativeRead` 设置 `-e safMode select` 后，由用户在实际系统选择器中选目录；可用 `-e safExpectedName <显示名>` 在读取前检查所选目录。仅当前层元数据与原生读取，重复内容校验不输出路径/文件名/哈希。
- 强制停止应用后运行 `processRestartRestoresTheReadGrantAndIdentity`（`-e safMode restore`）验证持久读取授权和身份；`pickerCancellationPreservesRoots`（`-e safMode cancel`）验证取消不丢目录。
- `SafPublicationTest` 通过真实系统选择器验证独立目标发布。先在设备 Download 新建 `SaveDataSync-Publish-<16位小写十六进制>`，放入 `control.sav` 及已有 `existing-parent/control-nested.sav`，从设备外记录原文/大小/mtime/inode；以 `-e publicationToken <后缀> -e class io.github.galgame.savedatasync.SafPublicationTest#selectExactIsolatedPublicationFixture` 运行并在选择器授权精确目录，再用同 token 运行 `#actualSafPublicationPermissionCollisionCancellationAndArchiveIntegration`。没有 token 时交互用例跳过，传入后未授权或失败必须报错。重复选择先清除旧回执，防止把上一轮 READ 当成新 WRITE。
- 实际 API 33 外部存储提供者完整通过 2 项发布设备用例及 12 个原生结果：空/Unicode/131073 字节与归档读流发布、已有名称保护、真实提供者自动改名、创建/写入/回读取消、源校验失败、返回已有 ID，以及清理失败保留名额/显式重试。`cache/publication-device-results.json` 只含公开 DTO；取回后经共享 `isFileOutcome`/`isBatchState` 验证。设备外独立比对 4 份成功输出逐字节原文、竞争者内容、精确本轮文件集合及两份已有控制文件的原文/大小/mtime/inode；失败/取消无残留，写授权释放，测试配置隔离。授权 Activity 只在 debug 编入且不导出。
- `TransferBenchmarkTest` 为手工启用的 LAN/SAF 写入基准，默认跳过。只授权精确匹配的新测试目录，在前台执行有限缓冲传输、新建和写后回读，结束后释放该写授权并清理独立数据；不改只读注册表。授权 Activity 只编入 debug 且不导出。方法、控制端及实测结果见[基准报告](../../docs/experiments/transfer-benchmark-2026-10-26.md)。
- `ArchiveSafTest` 的 5 项设备专项共同验证 Python/Windows 固定产物、Java 原生编码、真实 SAF 流的已知/未知长度两轮快照、含已有子目录的同名文件、取消/复用、权限/类型与损坏归档拒绝；全部使用私有缓存且没有 SAF 写权限。运行前通过既有 `SafDirectoriesTest#pickerSelectionAndNativeRead` 用例选择 `SaveDataSync-Archive-<随机后缀>` 合成目录，再以 `-e class io.github.galgame.savedatasync.ArchiveSafTest -e archiveExpectedName <精确显示名>` 运行；缺少授权或夹具将失败，不跳过。
- 该合成目录顶层为 0 字节空文件、12 字节 UTF-8 内容、131073 字节二进制文件和一个已有子目录；子目录再含同名空文件名的 11 字节控制文件，总计 4 文件、131096 字节。测试前后从设备外复核全部合成源内容，原生层复核身份和元数据。未知长度轮只隐藏元数据长度，仍使用实际提供者的原生流实测。
- `scripts/verify-archive-interop.mjs prepare|verify` 已纳入 `pnpm android:test`。测试 APK 只打包共享固定夹具和生成的 Windows 清单/二进制，不包含主机目录配置或缓存。设备专项在私有 `cache/archive-device-java.gz` 输出独立格式夹具；以二进制取回到 `.reports/wp013-device/java.gz` 后运行 `node --experimental-strip-types scripts/verify-archive-interop.mjs verify-device`，由 Windows 原生解包器验证设备压缩器产物及独立内容期望。
- 实际 SAF 专项另外输出私有 `cache/archive-device-saf.gz` 与 `cache/archive-device-saf.json`；二进制取回到 `.reports/wp013-device/saf.gz`、`saf-manifest.json`，保留原本四份上传合成源为 `empty.sav`、`unicode.sav`、`large.sav`、`control.sav` 后，`verify-device-saf` 模式用 Windows 原生接收器逐项核对原文。设备报告副本验证后可删除，受管理归档任务在每项测试结束时已清理。

WP-006 的 API 33 实际验证通过 ADB 开发者控制台操作正式原生桥，文件数据使用真正 LAN HTTP，调试通道不承载传输体。实际双向各 3 文件（空/UTF-8/131073 字节）及 2 轮后台 1 MiB 接收，共 8 份输出与原文逐字节一致；6 份原生/远端状态及 10 份进度快照经共享守卫匹配。返回桌面后持续通知/dataSync 服务仍存在，Activity 重建后 current 可取回同一任务，后台完成后通知和服务消失；显式取消无目标残留，私有缓存仅剩根所有权。两端原文件的内容/大小/mtime/身份保持，测试目录权限与临时服务回收。通知截图及原始回执仅在忽略的本地报告中保留。旧后台自动取消用例已移除。

真实存档禁止写入、修改或删除。损坏配置/失效权限夹具使用独立的应用私有配置；不会撤销真实根授权。Android 10、其它提供者与最终界面需在后续总体验收矩阵验证；实际 API 33 SAF/正式 LAN HTTP 与通知保持传输已完成。
