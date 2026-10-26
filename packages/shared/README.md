# 共享契约

## 目录

- [1. 范围与兼容性](#1-范围与兼容性)
- [2. 本地目录与批量模型](#2-本地目录与批量模型)
- [3. 守卫与上下文匹配](#3-守卫与上下文匹配)
- [4. HTTP 线格式与预算](#4-http-线格式与预算)
- [5. 资源及跨语言责任](#5-资源及跨语言责任)
- [6. 检查与验证边界](#6-检查与验证边界)

## 1. 范围与兼容性

`@savedata-sync/shared` 从 `src/index.ts` 导出应用名、协议 v1 的本地目录/设备 DTO、tar.gz 批量 DTO、纯数据守卫、上下文匹配器和协议常量。共享包不包含 IO、归档编解码、HTTP 服务/客户端、任务存储或同步算法。

协议使用数字 `PROTOCOL_VERSION=1`。本地目录桥使用 DeviceDescriptor、DirectoryReference、EntryMetadata、DirectoryListing 和 DirectorySelectionResult；HTTP 的 DeviceResponse 为 `OperationResult<BatchDeviceDescriptor>`，包装本地 device 并提供 sessionId/limits。

传输使用 BatchProgress/BatchState/FileOutcome、DownloadBatchRequest/ReceiveBatchRequest、BatchResponse/ManifestResponse，以及批量路由和归档校验头；接受接收成功前必须执行上下文匹配。不提供单文件端点或兼容别名。无 HTTP 消费者阶段原位修订 v1 的例外不作为正式消费者出现后的兼容策略。

详细目标行为见[批量协议设计](../../docs/plans/m001-tar-gzip-protocol.md)；共享包负责数据与关系约束，Windows 私有归档已实现，Java 归档、HTTP 和目标发布待后续平台包完成。

## 2. 本地目录与批量模型

| 对象 | 语义与约束 |
| --- | --- |
| 本地设备/目录 | 安装内 deviceId 与连接地址分离；授权 granted/expired/unavailable/unverified；URI 与真实路径留在平台内部；选择取消不清除原目录 |
| 元数据/当前层 | file/directory 联合；目录 sizeBytes 固定 null，文件未知为 null、空文件为 0；时间为 Unix 毫秒（±8.64e15 内安全整数），0 和负数有效；只列当前层，不汇总目录大小 |
| 基本数据 | ID 为 1–128 位 URL 安全 ASCII；SHA-256 为 64 位小写十六进制；展示文本非空白、最多 1024 个 UTF-16 码元且不含未配对代理项；无类型强制转换 |
| 共同创建名 | 最多 255 个 UTF-16 码元；拒绝路径、控制字符、Windows 保留名及尾部点/空格；保留合法 Unicode，不归一化/改名；实际名称竞争仍由平台验证 |
| SourceSelection / DownloadBatchRequest | 单个已登记源根内的显式文件引用；fileId 必须从 f000001 连续到最多 f001024，源 entryId 不重复，不接受空批或目录展开 |
| PreparedFile / BatchManifest | 源引用、显示名/日期和本次实际长度/哈希；未知源长度必须先实测；校验文件求和、源唯一性和精确 tar 长度；清单不保存为历史基线 |
| ArchiveDescriptor | format=tar.gz、compressionLevel=1、实际压缩体长度、tar 原文长度、实际归档哈希；不同压缩器可以产生不同字节，接收端验证本次归档 |
| TargetSelection / ReceiveBatchRequest | 用 fileId 一一映射 targetRootId 内已有 parentId 和单文件名；映射顺序可与清单不同，缺项/重复/额外项/显式同目标拒绝；不按 tar 路径创建文件 |
| BatchProgress | 分开 sourceBytesRead、archiveBytesTransferred、fileBytesVerified、fileBytesPublished；totalFileBytes/totalArchiveBytes 未知为 null；文件数、字节及阶段关系检查，不代表文件夹大小 |
| BatchState | running 含 stage/progress/cancelRequested；终态含 error/fileResults/cleanupStatus/cleanupError；角色为 sender 或 receiver，不混用字段 |
| FileOutcome | 成功带 bytesWritten/sha256/实际文件 entry；失败和取消可带本次残留；未知必须 result-unknown；未尝试带 batch-invalid/prior-failure/cancelled 原因 |

sender 的 sent 只表示本机发送完成，不代表对端已接收或发布；sender 不允许报告 succeeded 或逐文件目标结果。receiver 的 succeeded 必须全项成功。首次失败/取消/未知停止后续发布，最终结果按连续 fileId 覆盖全部清单；保留前项成功，后项用准确的 not-attempted 原因。校验整批失败时全部为 not-attempted/batch-invalid。

私有缓存清理状态与目标发布结果分开：已确认发布成功但清理失败仍保留 succeeded，cleanupStatus=incomplete 且 cleanupError=cleanup-failed；不把真实成功写入改报为未写入。unknown 使用 result-unknown 且 canRetry=false，空残留数组不能证明没有残留。

## 3. 守卫与上下文匹配

`is…` 守卫只接收已解析 JSON/plain data，不修改、克隆或冻结输入，不执行 IO/哈希/归档校验。非普通容器、稀疏数组、缺失/额外字段、非法联合或超范围值返回 false。它们不防御可执行 getter/Proxy；调用方应先在解析层拒绝重复 JSON 键、非法 UTF-8、超限文本和歧义 HTTP 定界。

本地守卫为 isDeviceDescriptor、isDirectoryReference、isEntryReference、isEntryMetadata、isDirectoryListing、isOperationError、isOperationResult 和 isDirectorySelectionResult。批量守卫为 isBatchLimits、isBatchDeviceDescriptor、isSourceSelection、isDownloadBatchRequest、isPreparedFile、isArchiveDescriptor、isBatchManifest、isTargetSelection、isReceiveBatchRequest、isBatchProgress、isFileOutcome 和 isBatchState。isBatchFileId/isOpaqueId/isSha256/isPortableFileName/isProtocolVersionSupported 为纯值辅助守卫。

`matchesBatchState(value, manifest, direction, receiver?)` 在结构校验后与本任务上下文核对：任务 ID、方向、清单一致性、全部结果数量、字节/哈希、目标根/父目录/名称及重复最终条目。sender 不传 receiver，receiver 必须传入完整 ReceiveBatchRequest；缺少目标上下文不能接受成功。不以 JSON 序列化字段顺序或对象身份判断清单相同。

`isBatchProgressAdvance(previous, next)` 只比较同任务的进度值，检查计数单调、总文件数相同，以及已知总量不改写；调用方先核实任务身份、会话、角色、时间和阶段。它不实现任务状态机或自动重试。

```ts
import { isBatchState, isOperationResult, matchesBatchState } from '@savedata-sync/shared'
import type { ReceiveBatchRequest } from '@savedata-sync/shared'

// request 是本次已验证的 Android → Windows 接收请求；payload 是已解析的状态响应。
function inspectUpload(payload: unknown, request: ReceiveBatchRequest): string {
  if (!isOperationResult(payload, isBatchState)) return '响应格式错误'
  if (payload.status === 'error') return payload.error.message
  if (!matchesBatchState(payload.value, request.manifest, 'android-to-windows', request)) {
    return '任务结果与本次清单或目标不符'
  }
  if (payload.value.status === 'succeeded') return '全部文件已发布并回读确认'
  if (payload.value.status === 'unknown') return '结果待确认，请重新读取目标核实'
  return payload.value.status
}
```

结构/关系校验都不能证明提供者未覆盖已有文件或内容确实回读正确；平台仍要执行权限、身份、名称等价、非覆盖发布和真实内容校验。读取配置中的 deviceId 与当前连接返回的 deviceId/sessionId 也由调用者核实。

## 4. HTTP 线格式与预算

以下路由/头和数据声明已导出，HTTP 行为尚未实现。除 GET /v1/device 外，请求均须唯一 `x-sync-session-id`；会话随服务重启改变，不等于稳定设备 ID，也不是认证。

| 路由 | 方法与输入 | 成功响应 |
| --- | --- | --- |
| /v1/device | GET | 200，DeviceResponse，值为 device/sessionId/limits |
| /v1/roots | GET | 200，RootsResponse，只返回本机已选择根 |
| /v1/roots/{rootId}/entries | GET；可选 parentId 查询参数，省略为 null | 200，DirectoryResponse，当前层清单 |
| /v1/transfers/downloads | POST；DownloadBatchRequest JSON | 202，BatchResponse，异步准备 sender |
| /v1/transfers/{transferId}/manifest | GET | 200，ManifestResponse，仅已准备好的清单 |
| /v1/transfers/{transferId}/content | GET；sender ready，单次领取 | 200，application/gzip 原始体 |
| /v1/transfers/uploads | POST；ReceiveBatchRequest JSON | 201，BatchResponse，仅登记 receiver |
| /v1/transfers/{transferId}/content | PUT；receiver awaiting-content，唯一压缩体 | 202，BatchResponse，收齐后异步校验/发布 |
| /v1/transfers/{transferId} | GET / DELETE | 查询 200；取消活动任务 202/已有终态 200；BatchResponse 为实际状态 |

JSON 使用 OperationResult 互斥包络。201/202 和查询 200 均不表示文件已发布；必须检查批次/逐文件结果并执行上下文匹配。归档 content 的 Content-Length 和 `x-archive-sha256` 必填，与 manifest.archive 一致；不设 Content-Encoding，不自动解压/重定向，不支持 Range、续传或自动重放。文件名/目标映射放 JSON，目录 parentId 仍按查询参数规则解码一次。

`BATCH_LIMITS` 固定每批 1024 文件、单文件 256 MiB、原文合计 1 GiB、tar 1 GiB+1 MiB、压缩体 1088 MiB、单个 JSON 8 MiB、每端一个活动任务、每会话 4096 个已接纳 ID。`BATCH_RESOURCES` 为 64 KiB 显式 IO 缓冲和 3 GiB 私有缓存；`BATCH_TIMEOUTS_MS` 为 ready 等待 10 分钟、等上传体 2 分钟、总期限 30 分钟、网络无进展 60 秒、终态保留 10 分钟。这里只提供常量，计时/限流/缓存/ID 生命周期由平台实现。

`BATCH_ARCHIVE` 固定受限 USTAR、gzip level 1 和 application/gzip；成员名仅 fileId。声明的 tarSizeBytes 必须为 `Σ(512 + ceil(sizeBytes/512)×512)+1024`；真实 tar 头、填充、结束、gzip 单 member/CRC/ISIZE 和所有 SHA-256 的检查留给原生编解码器。技术预算不作为全产品规模或峰值内存保证。

HTTP_ERROR_STATUS 保留既有错误映射，并增加 session-mismatch/task-conflict=409、invalid-archive=422、resource-limit=413、busy=429、timeout=408；network-failure 仍映射 null，无可伪造 HTTP 响应。session-mismatch 和 result-unknown 均禁止 canRetry=true；其他 canRetry 也只允许核实当前状态后由用户新建操作。

## 5. 资源及跨语言责任

- 原生层拥有流、压缩器、缓存、任务、回调和监听；向 JS 仅传 JSON 快照，不传文件内容、Base64、句柄或 URI。Android 使用 Java，long 输出前检查 JS 安全整数范围。
- 准备时源原文先流式暂存并实测长度/哈希，再打包稳定归档；接收端完整验证归档和全部原文后才逐项发布。清单、哈希及结果只在当前会话短期存活，不保存历史基线。
- Windows 私有归档及源变化检查已在[桌面适配](../../apps/desktop/README.md)实现；Java 归档、JSON/HTTP 解析和非覆盖目标发布仍待后续包。共同创建名不能替代 Windows 竞争检查或 SAF 提供者验证。
- Android 离开前台取消本地任务并尽力取消远端，取消丢失可能留下已发布结果；返回前台核实当前目标，不恢复旧任务。共享包不控制生命周期，也不保证平台操作可立即中断。

## 6. 检查与验证边界

- `pnpm test:shared`：32 项运行时测试，包括 12 项本地模型/错误/名称回归及 20 项批量/上下文用例；使用 Node 内置测试器和类型擦除，无新增依赖。
- `pnpm --filter @savedata-sync/shared typecheck`：类型检查包含 16 项预期失败反例，覆盖只读快照、角色终态、压缩参数和未知/会话重试边界。
- `pnpm check`：共享检查及既有双端目录桥测试、严格类型和 Web/Electron 构建；本包仅使用 ES2022 标准库，关闭平台类型自动注入。

成员/单项/总原文/tar/压缩体边界通过纯数据用例验证，不分配真实大文件；超限 JSON、重复键、非法归档字节、真实 IO、网络、SAF 发布和前台中断均不是本包已验证能力。后续归档与 HTTP 包按设计故障矩阵补齐，不能将共享守卫通过当作完整产品验收。
