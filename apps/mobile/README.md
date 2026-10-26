# Android 目录读取与原生归档

## 目录

- [界面入口](#界面入口)
- [原生边界](#原生边界)
- [原生归档接口](#原生归档接口)
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

`chooseDirectory()` 返回共享 `DirectorySelectionResult`；取消保留既有目录。`listRoots()` 返回 `OperationResult<readonly DirectoryReference[]>`；保存的引用失去权限时仍存在，authorization 为 expired。`listDirectory(rootId, parentId = null)` 返回当前层 `OperationResult<DirectoryListing>`，parentId 只能来自当前原生会话枚举出的目录条目。重建插件后先重新列目录，不复用旧 entryId。

TS 桥校验请求与响应，拒绝路径/URI、附加字段及跨根/跨层响应；原生插件也独立校验请求。未安装插件、畸形返回和连接异常转为脱敏错误。网页预览返回 unsupported-operation。当前空壳尚未接入这些按钮，最终界面由后续工作包完成。

## 原生边界

`android/app/src/main/java/io/github/galgame/savedatasync/` 中：

- `SafDirectoriesPlugin` 注册系统目录选择器，后台线程串行访问提供者；暂停时取消查询，销毁时关闭执行器。选择器需要系统确认，只请求并持久化 READ；不使用 root。
- `SafDirectoryStore` 独立持久化 schema 1、安装内 deviceId、根 rootId/URI/显示名。配置损坏或版本未知时失败，不重建覆盖。文件清单、文件哈希和 entryId 不持久化。
- 当前层查询不扫描后代；目录 sizeBytes=null，未知文件大小=null，空文件=0。SAF 日期 0 表示未知，映射 null；超出 JS 安全范围的数字拒绝。写入、新建、重命名、删除能力均为 unsupported；未知提供者能力不冒充支持。
- `openFile(rootId, entryId, signal)` 仅供同包原生代码使用：重查授权、文件类型和已观察到的名称/大小/日期，以 `r` 打开 `InputStream`。调用者拥有并必须关闭流；取消在读取时检查，未来传输生命周期所有者还必须关闭阻塞流。异常为 `SafFailure`，原始 cause 仅留原生层，JS 仅见脱敏码/消息。

URI 与 documentId 不转换为文件系统路径；文件内容不进入 JavaScript/Base64。文件 ID 由提供者维护；属性检查不能保证恶意并发修改下的原子内容快照，后续传输仍须校验实际字节/哈希。正式接口当前没有新文件写入或 HTTP 传输实现；独立调试基准仅验证测试目录内的机制，不向现有只读桥加入写方法。

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
- `receive(manifest, input, control, progress)` 接管并关闭输入。先完整暂存并核对压缩体长度/SHA-256，再严格检查单 gzip member、DEFLATE 结束、CRC32/ISIZE、全部 USTAR 字段/顺序/零填充/精确结束和每份原文长度/SHA-256；全部通过才返回私有句柄。拒绝拼接、尾随、扩展、链接和路径。输入为固定 v1 原生不可变模型；JSON/版本/封闭字段解析由后续网络包负责。
- `Artifact.manifest` 及其文件数组不可变；`openArchive`/`openFile(fileId)` 返回调用者负责关闭的只读流，fileId 必须属于该清单。关闭全部流后调用 `close()`（即 dispose）；句柄随后失效。源、归档和解包均显式使用至多 64 KiB 缓冲，逐文件处理。
- `ArchiveModel.Limits` 固定上限为 1024 文件、单项 256 MiB、原文合计 1 GiB、tar 1 GiB+1 MiB、压缩体 1088 MiB、实际私有缓存合计 3 GiB；测试注入只能收紧。声明、实际读取/解压/写入均计数，空间预检不代替实际失败处理。
- `ArchiveControl` 在每次 I/O、解压和进度检查取消、线程中断及不刷新的 30 分钟总期限；`cancel()` 可从生命周期线程调用，会关闭已登记的读流并取消 SAF 查询。外层任务所有者负责在期限到达或离开前台时主动 cancel 以唤醒阻塞的提供者，再等待工作线程清理；本模块不创建后台服务或恢复旧任务。
- `ArchiveCache` 仅在可信 Context 的真实私有缓存路径创建 `transfer-archives-v1`，根/随机任务都有所有权标记，拒绝其下链接/未知条目。每个进程只允许一个任务，句柄和清理失败均占名额。重启只清除可验证的孤儿缓存；不恢复旧结果。`ArchiveCache.retryOrphanCleanup()` 只重试已核实的启动孤儿，不关闭活动任务。
- `ArchiveFailure.code` 为稳定错误码，原始 cause 仅留原生层；取消以 `cancelled=true` 区分，清理失败保留主错误并放入 `cleanupFailure`。关闭读流后可调用 `adapter.retryCleanup()`；确认成功的内容校验不会被清理状态伪装成未发生。回调在同一 I/O 线程接收阶段、实际字节数及可空总量，未知长度不伪造百分比。

该包已完成实际 API 33 SAF 读流集成与设备验收；HTTP、SAF 目标新文件发布及前台网络编排分别由 WP-006/WP-010 承接。

## 验证

- `pnpm test:mobile`：可注入 TS 桥的契约与失败边界，纳入 `pnpm check`。
- `pnpm android:test`：同步 Web 工程，生成 Windows 原生归档供 Java 消费，执行 Java 单元测试、Android lint，构建调试 APK 与仪器测试 APK，最后用 Windows 原生 receiver 解包 Java 产物；CI 同样执行，不自动连接设备。共 30 项 Java 单元，其中 25 项为归档专项。
- 安装两个调试 APK 后，`adb shell am instrument -w io.github.galgame.savedatasync.test/androidx.test.runner.AndroidJUnitRunner` 执行独立私有夹具与原生桥参数验证。交互用例默认跳过。
- 对 `io.github.galgame.savedatasync.SafDirectoriesTest#pickerSelectionAndNativeRead` 设置 `-e safMode select` 后，由用户在实际系统选择器中选目录；可用 `-e safExpectedName <显示名>` 在读取前检查所选目录。仅当前层元数据与原生读取，重复内容校验不输出路径/文件名/哈希。
- 强制停止应用后运行 `processRestartRestoresTheReadGrantAndIdentity`（`-e safMode restore`）验证持久读取授权和身份；`pickerCancellationPreservesRoots`（`-e safMode cancel`）验证取消不丢目录。
- `TransferBenchmarkTest` 为手工启用的 LAN/SAF 写入基准，默认跳过。只授权精确匹配的新测试目录，在前台执行有限缓冲传输、新建和写后回读，结束后释放该写授权并清理独立数据；不改只读注册表。授权 Activity 只编入 debug 且不导出。方法、控制端及实测结果见[基准报告](../../docs/experiments/transfer-benchmark-2026-10-26.md)。
- `ArchiveSafTest` 的 5 项设备专项共同验证 Python/Windows 固定产物、Java 原生编码、真实 SAF 流的已知/未知长度两轮快照、含已有子目录的同名文件、取消/复用、权限/类型与损坏归档拒绝；全部使用私有缓存且没有 SAF 写权限。运行前通过既有 `SafDirectoriesTest#pickerSelectionAndNativeRead` 用例选择 `SaveDataSync-Archive-<随机后缀>` 合成目录，再以 `-e class io.github.galgame.savedatasync.ArchiveSafTest -e archiveExpectedName <精确显示名>` 运行；缺少授权或夹具将失败，不跳过。
- 该合成目录顶层为 0 字节空文件、12 字节 UTF-8 内容、131073 字节二进制文件和一个已有子目录；子目录再含同名空文件名的 11 字节控制文件，总计 4 文件、131096 字节。测试前后从设备外复核全部合成源内容，原生层复核身份和元数据。未知长度轮只隐藏元数据长度，仍使用实际提供者的原生流实测。
- `scripts/verify-archive-interop.mjs prepare|verify` 已纳入 `pnpm android:test`。测试 APK 只打包共享固定夹具和生成的 Windows 清单/二进制，不包含主机目录配置或缓存。设备专项在私有 `cache/archive-device-java.gz` 输出独立格式夹具；以二进制取回到 `.reports/wp013-device/java.gz` 后运行 `node --experimental-strip-types scripts/verify-archive-interop.mjs verify-device`，由 Windows 原生解包器验证设备压缩器产物及独立内容期望。
- 实际 SAF 专项另外输出私有 `cache/archive-device-saf.gz` 与 `cache/archive-device-saf.json`；二进制取回到 `.reports/wp013-device/saf.gz`、`saf-manifest.json`，保留原本四份上传合成源为 `empty.sav`、`unicode.sav`、`large.sav`、`control.sav` 后，`verify-device-saf` 模式用 Windows 原生接收器逐项核对原文。设备报告副本验证后可删除，受管理归档任务在每项测试结束时已清理。

真实存档禁止写入、修改或删除。损坏配置/失效权限夹具使用独立的应用私有配置；不会撤销真实根授权。Android 10、其它提供者、HTTP、写入及最终界面需在后续矩阵单独验证。
