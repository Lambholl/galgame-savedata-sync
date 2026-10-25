# Android 目录读取适配

## 目录

- [界面入口](#界面入口)
- [原生边界](#原生边界)
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

## 验证

- `pnpm test:mobile`：可注入 TS 桥的契约与失败边界，纳入 `pnpm check`。
- `pnpm android:test`：同步 Web 工程，执行 Java 单元测试、Android lint，构建调试 APK 与仪器测试 APK；CI 同样执行，不自动连接设备。
- 安装两个调试 APK 后，`adb shell am instrument -w io.github.galgame.savedatasync.test/androidx.test.runner.AndroidJUnitRunner` 执行独立私有夹具与原生桥参数验证。交互用例默认跳过。
- 对 `io.github.galgame.savedatasync.SafDirectoriesTest#pickerSelectionAndNativeRead` 设置 `-e safMode select` 后，由用户在实际系统选择器中选目录；可用 `-e safExpectedName <显示名>` 在读取前检查所选目录。仅当前层元数据与原生读取，重复内容校验不输出路径/文件名/哈希。
- 强制停止应用后运行 `processRestartRestoresTheReadGrantAndIdentity`（`-e safMode restore`）验证持久读取授权和身份；`pickerCancellationPreservesRoots`（`-e safMode cancel`）验证取消不丢目录。
- `TransferBenchmarkTest` 为手工启用的 LAN/SAF 写入基准，默认跳过。只授权精确匹配的新测试目录，在前台执行有限缓冲传输、新建和写后回读，结束后释放该写授权并清理独立数据；不改只读注册表。授权 Activity 只编入 debug 且不导出。方法、控制端及实测结果见[基准报告](../../docs/experiments/transfer-benchmark-2026-10-26.md)。

真实存档禁止写入、修改或删除。损坏配置/失效权限夹具使用独立的应用私有配置；不会撤销真实根授权。Android 10、其它提供者、HTTP、写入及最终界面需在后续矩阵单独验证。
