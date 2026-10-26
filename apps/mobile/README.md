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

正式界面由 `packages/ui` 提供，平台接入位于 `src/library-adapter.ts`。设备、游戏、设置为三个主入口；可保存多台电脑，一个游戏可关联多台设备，首期同时只连接一台。游戏名称、目录引用和设备关联自动保存到本机网页存储，平台路径和授权仍留在原生层。

连接电脑后可明确导入对端游戏，再选择自己的目录；已有游戏也能选择对应的远端游戏建立关联。传输页左右并列显示两端当前层文件，时间精确到分钟。操作采用 antd/antd-mobile 按钮，目录和地址使用 antd 紧凑输入组合；文件条目不再打开重复信息弹窗。

当前支持源文件选择、目标名称、开始确认、真实进度、取消和逐文件结果。接收前用“允许手机接收”选择独立测试目录并确认；电脑接收目标由电脑本机授权。覆盖、镜像删除和备份恢复的文件操作按后续里程碑开放。

地址单独保存在本地网页存储，目录引用及系统授权由原生层保存。切后台暂停界面轮询，传输继续由原生通知持有；回前台恢复查询，页面重载通过 `current()` 取得同一任务。任务结果与正在浏览的目录分开展示；重启进程后重新确认接收目标。刷新根目录后按用户已展开路径重读祖先，恢复有效条目引用，不扫描其他分支或汇总文件夹大小。

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

`chooseDirectory()` 返回共享 `DirectorySelectionResult`；取消保留既有目录。`listRoots()` 返回 `OperationResult<readonly DirectoryReference[]>`；保存的引用失去权限时仍存在，authorization 为 expired。`listDirectory(rootId, parentId = null)` 返回当前层 `OperationResult<DirectoryListing>`，parentId 必须来自当前原生会话枚举出的目录条目。重建进程后先重新列目录，不复用旧 entryId；同一进程的目录桥和传输模块通过 SafRuntime 共享当前引用。

TS 桥校验请求与响应，拒绝路径/URI、附加字段及跨根/跨层响应；原生插件也独立校验请求。未安装插件、畸形返回和连接异常转为脱敏错误。网页预览返回 unsupported-operation；系统目录与传输操作使用 Android 应用。

## 系统明暗主题

页面首次挂载前读取 `prefers-color-scheme`，通过 antd-mobile 的 `data-prefers-color-scheme` 属性切换完整主题，并监听运行时变化；热更新时释放旧监听。按用户要求，移动端暗色页面、启动及原生窗口背景统一为纯黑 `#000000`；文字和空状态说明使用组件库的明暗语义色，浏览器原生控件随主题切换。

Android 使用日夜主题及 `values`/`values-night` 的窗口/启动背景，WebView 为透明底色；运行中以 MainActivity 的 `savedata:theme-change` 原生通知（仅含 `dark: boolean`）为准修正 WebView 缓存的媒体查询，并用 Capacitor 内置 `SystemBars` 显式同步系统栏图标颜色。媒体与原生事件监听均可清理。应用自行渲染暗色，关闭原生自动反色。当前没有手动开关或持久化主题偏好。

## 原生边界

`android/app/src/main/java/io/github/galgame/savedatasync/` 中：

- `SafDirectoriesPlugin` 注册系统目录选择器，后台线程串行访问提供者；暂停时取消查询，销毁时关闭执行器。选择器需要系统确认，只请求并持久化 READ；不使用 root。
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

`src/http-transfers.ts` 导出 `androidTransfers`，已接入 WP-007 界面。文件字节只经过 Java 原生流，JS 接收目录、清单、句柄和实际任务状态；网页预览不发起原生操作。

下载在清单准备前取消或失败，也会生成本地接收终态，全部文件标为“未尝试”。桥在缺少清单时只接受与本次文件 ID、顺序和失败/取消原因精确匹配的该类结果；已写入结果继续要求完整清单、哈希及目标匹配。刷新结果保留已取得的终态，查询失败另行提示；电脑清理失败须到桌面重试。

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

`TransferHttp.Client` 使用无代理的 HttpURLConnection，明确 identity，并关闭自动解压、重定向和缓存；控制体和 gzip 体分别限额。压缩体必须匹配唯一 Content-Length/SHA-256，歧义定界和 Content-Encoding 会被拒绝。显式缓冲 64 KiB，绝对总期限 30 分钟、网络无进展 60 秒；使用固定长度发送。POST/PUT 丢失回执时只查询同 ID，不重发。取消线程断开连接，原 I/O 线程关闭网络缓冲流，避免 Android Okio 与 read 并发 close。

上行复用原生源快照/归档，先核实 Windows awaiting-content 再唯一 PUT，手机仅报告 sender sent，继续核实独立 Windows receiver 结果。下行核实来源和全部本地目标后才 GET content，完整压缩体/全部原文通过前不创建 SAF 文件；首次发布失败停止后项，成功、失败/取消/未知及未尝试分别报告。已确认成功不因晚取消或清理失败回滚。

`TransferRuntime` 使用应用 Context 持有任务与原生适配器，Activity 仅弱订阅，不拥有传输生命周期。用户发起任务前先确认 `TransferService` 的 dataSync 前台服务和持续通知已启动；Android 13+ 需通知权限。Activity 暂停、销毁或回到桌面后，原任务继续运行；完成/显式取消并清理后服务和通知结束。通知展示阶段/进度，提供显式取消或残留清理重试，点击可回到应用查询原任务。

声明 FOREGROUND_SERVICE、FOREGROUND_SERVICE_DATA_SYNC、POST_NOTIFICATIONS；服务不导出、START_NOT_STICKY，没有开机接收器、定时同步或旧任务恢复。系统结束服务或进程后，任务不会记成成功，也不会自动重放。已有终态/清单保留 10 分钟，本地最多保留 32 份结果，进程最多 4096 个已用 ID；到期仍保留 ID 防重记录。实际支持的目录和系统/提供者能力以调用结果为准。

Android 行为依据见 [dataSync 前台服务](https://developer.android.com/develop/background-work/services/fgs/service-types)、[通知权限](https://developer.android.com/develop/ui/compose/notifications/notification-permission)及 [HttpURLConnection](https://developer.android.com/reference/java/net/HttpURLConnection)。

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

真实存档只读，不写入、不修改、不删除。损坏配置和失效权限夹具使用独立的应用私有配置，不改真实根授权。API 33 的 SAF、正式 LAN HTTP、通知保持传输和最小界面已通过；WP-007 实际检查了空文件/中文名双向内容、子目录刷新后传输、准备前取消、同名冲突、页面重载与 64 MiB 后台上传并外部核对 SHA-256。Android 10、其它提供者及规模资源仍留 WP-008。
