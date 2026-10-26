# Windows 目录与私有归档适配

## 目录

- [1. 范围与入口](#1-范围与入口)
- [2. 主进程接口](#2-主进程接口)
- [3. 有限 IPC](#3-有限-ipc)
- [4. 配置与路径边界](#4-配置与路径边界)
- [5. 验证](#5-验证)
- [6. 私有归档接口](#6-私有归档接口)
- [7. 缓存与格式边界](#7-缓存与格式边界)

## 1. 范围与入口

`src/main/directory-adapter.ts` 提供 Windows 本机的目录登记、恢复、当前层元数据和原生只读文件流。目录通过系统选择器进入主进程，Renderer 不提交绝对路径；界面按钮与浏览布局在后续界面工作包接入。

目录模块保持源只读；私有归档模块另提供快照、打包/解包与缓存清理。目标发布、覆盖、删除及 HTTP 尚未实现。真实用户目录仅用于只读检查；自动化测试只修改自己创建的临时夹具，不推断游戏引擎或存档格式。

## 2. 主进程接口

| 接口 | 输入/输出 | 生命周期与失败 |
| --- | --- | --- |
| createDirectoryAdapter(configPath) | 主进程控制的绝对配置路径，返回适配器 | 不存在时创建身份；损坏/未知 schema、无效文件或权限失败抛异常，不重置原配置 |
| adapter.deviceId | 返回安装内稳定设备 ID | 与 IP 无关，不从机器 MAC 生成 |
| adapter.registerDirectory(path) | 仅系统选择器/受信任本地调用传入绝对目录；返回 OperationResult&lt;DirectoryReference&gt; | 配置保存后才更新内存；再次明确选择同一路径保留 rootId，重新核实身份并清除该根的旧条目引用 |
| adapter.listRoots() | 返回公开根引用列表 | 重查根身份；失效根标 unavailable，仍保留配置，不冒充空目录 |
| adapter.listDirectory(rootId, parentId=null) | 当前层 DirectoryListing | 根层 parentId=null；子层必须使用已采集目录的 entryId。不会递归读取后代，不汇总目录大小；不支持的链接/类型及读取失败返回错误 |
| adapter.openFile(reference) | 本进程有效的 EntryReference，返回 metadata、Node Readable 和 verifyUnchanged() | 调用者消费/关闭流后调用检查点，重查原身份、大小、mtime/ctime；不重新读内容，不保证发现任意并发写入；流自动关闭句柄 |
| adapter.assertCacheIsolated(path) | 仅主进程传入缓存绝对路径 | 拒绝缓存与任何已登记根互相包含；不创建目录或向 IPC 暴露路径 |

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

应用退出时移除 handler，窗口关闭时删除可信窗口记录；应用采用单实例锁避免通常情况下多个应用实例同时更新同一配置。该包没有事件订阅，网页调用者不持有需要释放的文件句柄。

## 4. 配置与路径边界

应用在 `app.getPath('userData')/directory-config.json` 保存 schemaVersion=1、deviceId 与 roots。内部根记录仅含 rootId、规范路径和 bigint dev/ino 的字符串身份；绝对路径不传到 Renderer，也不写进项目记忆。条目 ID/相对路径映射只在本进程内有效，不保存历史元数据或哈希，重启后重新枚举。

配置写入使用同目录独占临时文件、sync 和 rename；同进程登记串行处理，成功前不更新内存。配置不能位于任何所选根目录内，损坏或未知版本一律停止初始化。配置目录必须由应用控制，本实现不提供跨外部进程的配置事务或锁。

每次读取重新检查根身份；路径逐段 lstat，拒绝 symlink/junction，核对 realpath 与根范围，读取句柄再核对身份。文件/目录替换使旧引用失效，需要刷新或明确重新选择。当前策略拒绝所有遇到的链接，不自动跟随根内链接；不支持的条目导致该层读取失败，不能静默显示为空目录。

Node 的路径检查与文件打开不是同一个原子操作。本实现检查可观察到的替换和越界，不承诺在外部进程恶意并发重排命名空间时提供内核级隔离；不引入目录级原子替换承诺。内容哈希与源变化校验由下述私有归档模块处理，写入授权和发布竞争留后续写入工作包。

Electron 构建显式内联 workspace 共享包，避免 sandbox preload 在运行时 require TypeScript 源码。preload 保留 CJS 输出，contextIsolation/sandbox 开启，Renderer 无 Node 集成。

## 5. 验证

`pnpm test:desktop` 执行 16 项既有目录/IPC 检查和 20 项归档专项检查，纳入 `pnpm check`。目录覆盖 Unicode/空文件、配置恢复、当前层、身份/链接越界、读流释放和有限 IPC。归档覆盖独立固定夹具、真实原生流、格式故障/超限、源变化、取消、所有权和清理重试。临时夹具基于 realpath 的系统临时根，避免 Windows 8.3 别名差异，不记录真实存档路径。

Windows 短路径回归通过 PowerShell 调用 GetShortPathName，生成真实 8.3 别名，并在只影响子进程的 TEMP/TMP 环境中重跑目录与 IPC 用例，要求全部通过。非 Windows 或卷未生成不同短名时明确跳过此项；常规用例仍执行。此修复只调整测试夹具，不放宽业务代码的链接、根范围和身份检查。

额外只读验证通过用户授权的真实 Windows 目录执行：读取前后文件内容哈希、条目和目录修改时间一致，原生读流一致，配置恢复成功；具体路径及文件哈希不进入仓库。该检查不代表 Android、HTTP 传输、原生选择器人工点击或完整界面已验收。

参考：[Node 文件系统](https://nodejs.org/docs/latest-v22.x/api/fs.html)、[Electron IPC 来源校验](https://www.electronjs.org/docs/latest/tutorial/security#17-validate-the-sender-of-all-ipc-messages)、[系统目录选择器](https://www.electronjs.org/docs/latest/api/dialog)。

## 6. 私有归档接口

`src/main/archive-adapter.ts` 仅供主进程调用，使用内置 fs/stream/zlib/crypto，无新增依赖。归档功能尚未接入 HTTP 或 UI。所有文件、缓存和流留在原生层，不把归档对象或文件内容跨 preload/JS 桥传递。

| 接口 | 输入/输出 | 所有权与失败 |
| --- | --- | --- |
| createWindowsArchiveAdapter(source, privateDirectory, options?) | 目录读取适配器与既有应用私有绝对目录；返回归档适配器 | 缓存固定放 transfer-archives-v1 子目录，不能与任何已登记源根重叠；启动只清理验证过的孤儿缓存；失败抛脱敏 ArchiveError |
| archive.prepare(request, options?) | DownloadBatchRequest，返回 WindowsArchive | 按流复制源至私有快照，实测长度/SHA-256并核实读取后元数据，再打包 gzip1；成功后调用者持有缓存，必须 dispose |
| archive.receive(manifest, input, options?) | BatchManifest 和原始 Node Readable；返回 WindowsArchive | 从调用起接管并最终关闭 input；完整保存/校验压缩体及全部原文后才返回句柄；失败不提供可发布结果 |
| artifact.manifest | 冻结的本次清单、实际长度/哈希 | 仅当前任务使用，不持久化为历史基线；压缩字节不保证与另一压缩器相同 |
| artifact.openArchive() / openFile(fileId) | 只读流；fileId 必须属于本清单 | 调用者必须消费或 destroy；未关闭读流会使 dispose 报 busy；不返回缓存路径 |
| artifact.dispose() | Promise&lt;void&gt; | 幂等并合并并发清理；失败保留互斥，禁止新任务，允许再次 dispose 或 retryCleanup |
| archive.retryCleanup() | 重试本缓存根的失败清理 | 不删除其他缓存根或仍在操作/仍有读流的任务；清理成功后才释放进程互斥 |

操作 options 可传 signal 和 onProgress；期限由上层管理，预先/处理中取消均关闭可中断的流。普通 abort 抛 ArchiveCancelledError，TimeoutError signal 映射 timeout；若清理也失败，原错误保留，独立 cleanupError=cleanup-failed。普通 ArchiveError 的 operationError 只含共享稳定码/脱敏消息，内部 cause 不传到界面。

进度快照分开源读取、压缩体已暂存、原文校验字节与已校验文件数；已暂存不等于网络已发送，已解包不等于目标已发布。回调由原生任务调用，不在 Renderer 执行 IO；抛异常会中止并清理任务。

## 7. 缓存与格式边界

默认执行共享包的每文件/总原文/tar/压缩体上限、64 KiB 显式 IO 缓冲及 3 GiB 私有缓存预算。options.quota 可进一步收紧本机预算，不能放宽协议；options.io 仅供受信任主进程注入磁盘空间检查和删除能力。每次写入先计数/检查可用空间，仍处理实际 IO 错误；测试以小预算和有界流验证边界，不分配 GiB 文件。未测整进程峰值内存或全量大存档性能。

源快照和解包仅写到随机任务目录。根/任务都有所有权标记并检查目录身份，进程内仅一份活动缓存，成功句柄未释放也占用名额。清理先核实所有成员，再逐个 unlink 普通文件并 rmdir 空任务目录；拒绝陌生文件、子目录、链接和多重硬链接，不递归展开归档路径。不确定所有权或初始化身份时失败关闭；不声称对抗外部恶意并发重排私有命名空间。

归档严格按[批量协议](../../docs/plans/m001-tar-gzip-protocol.md)的规范化 USTAR 头、顺序 fileId、零填充和两个结束块生成/校验。gzip 限制固定头和单 member，使用原始 DEFLATE 解码并核对实际消耗字节、CRC32/ISIZE、完整 tar 长度及每文件 SHA-256；拒绝拼接、尾随、损坏、截断、链接及扩展头。全体验证通过后才返回私有句柄；目标新文件发布留独立写入包。

`test/fixtures/archive-v1.json` 由 Python 标准库独立生成，包含三份合成原文、规范 tar 和 gzip；测试验证 Node 编码的 tar 精确匹配独立预期，也验证 Node 解码 Python gzip，后续 Java 包复用这份夹具。测试中的完整 Buffer/gunzipSync 仅用于小夹具，产品路径使用有限缓冲流式 IO。
