# 共享契约

## 目录

- [1. 范围与入口](#1-范围与入口)
- [2. 数据与校验](#2-数据与校验)
- [3. HTTP 线协议](#3-http-线协议)
- [4. 生命周期与跨语言责任](#4-生命周期与跨语言责任)
- [5. 使用示例与检查](#5-使用示例与检查)

## 1. 范围与入口

`@savedata-sync/shared` 通过 `src/index.ts` 导出协议版本 1 的 DTO、路由/头名/错误映射和纯数据守卫。保留既有 `APP_NAME` 导出。没有文件读写、网络服务、同步算法、状态存储或平台适配；Windows 与 Android 的实际能力由后续工作包实现。

版本必须是数字 `1`，不能强制转换字符串或默认接受未来版本。协议对象采用封闭结构，缺失或额外字段均被守卫拒绝。用户确认当前 HTTP API 无业务消费者，允许在 WP-011 原位修订 v1 为[tar.gz 批量契约](../../docs/plans/m001-tar-gzip-protocol.md)，不另建 v2；此开发阶段例外不用于正式消费者出现后的不兼容变更。现有代码仍为下述单文件声明，批量类型/守卫/常量及测试尚未实现。不要将平台内部路径、content URI、历史文件索引加进公开 DTO。

## 2. 数据与校验

| 对象 | 规则 |
| --- | --- |
| ID | `deviceId`、`rootId`、`entryId`、`parentId`、`transferId` 为 1–128 个 ASCII 字符，首位字母或数字，后续允许字母、数字、下划线和短横线；大小写敏感。不接收路径、URI 或编码后的路径片段 |
| 根目录 | `authorization` 为 granted、expired、unavailable 或 unverified；地址独立于根引用，授权恢复及失效判定由适配器完成 |
| 条目 | `kind` 区分 file/directory；根层 `parentId=null`，entryId 不能等于 parentId；name 为原始展示名，不从它拼装可访问路径 |
| 大小 | 所有字节计数必须是非负安全整数；未知为 null，不以 0 代替；目录 sizeBytes 必须为 null |
| 日期 | Unix 毫秒整数，限制在 JavaScript 可表示日期范围 ±8.64e15；0 和负数为真实日期；未知修改日期为 null；日期不决定权威端 |
| 文本 | 展示名、条目名、错误信息非空白且不超过 1024 个 UTF-16 码元；错误信息由生产者脱敏，守卫不能自动发现隐私 |
| 能力 | supported、unsupported、unknown 三态；未知不等于不支持，平台声明能力也不保证实际操作成功 |
| 当前层清单 | entries 可为空；条目必须属于同一 rootId 和 parentId，entryId 不得重复；无递归大小计算 |
| 新文件名 | 1–255 个 UTF-16 码元，禁止路径字符、控制字符、未配对代理项、Windows 保留名称及尾部点/空格；保留合法 Unicode，不静默改名或归一化；提供者仍可拒绝创建 |
| SHA-256 | 严格 64 个小写十六进制字符，仅用于本次传输；守卫只检查格式，不计算内容或确认一致性 |

所有 `is…` 守卫用于检查解析后的 JSON/plain data，返回布尔值并提供类型收窄，不改变、克隆或冻结输入。它们不负责 JSON 文本解析或检查带恶意 getter/Proxy 的可执行对象；调用者先捕获解析错误，再调用守卫。跨异步/线程边界需要复制快照时由调用者负责。

`OperationResult<T>` 为 `{status:'success', value:T}` 或 `{status:'error', error:OperationError}`。成功空清单是有效空目录；权限失效或读取失败必须进入错误分支。取消系统选择器用 `DirectorySelectionResult` 的 cancelled 分支，保留既有有效引用。

## 3. HTTP 线协议

以下记录当前代码中已实现的单文件声明，尚无 HTTP 业务实现或消费者；不能用作后续批量适配器的目标规格。WP-011 将按上述批量设计直接替换对应 DTO、路由、头、进度/结果及错误映射，并同步本 README 和测试；本轮只交付设计。

| 路由 | 方法与输入 | 成功响应 |
| --- | --- | --- |
| /v1/device | GET | 200，DeviceResponse |
| /v1/roots | GET | 200，RootsResponse；仅返回本机已选择的根 |
| /v1/roots/{rootId}/entries | GET；可选 parentId 查询参数，省略表示根层 | 200，DirectoryResponse |
| /v1/roots/{rootId}/files/{entryId}/content | GET | 200，application/octet-stream，x-content-sha256；已知长度时 Content-Length |
| /v1/roots/{rootId}/transfers/{transferId} | PUT；name、可选 parentId 查询参数；x-expected-sha256 必填；x-expected-size-bytes 可选；原始字节流 | 201，CreateFileResponse；必须发布并校验成功 |
| /v1/transfers/{transferId} | GET | 200，TransferResponse；查询成功不等于任务成功 |
| /v1/transfers/{transferId} | DELETE；请求取消，不删除已发布文件 | 200，TransferResponse；返回实际观察结果，不伪报已回滚 |

JSON 响应 `Content-Type: application/json`；守卫检查解包后的数据。除字节下载外，成功与失败使用 `OperationResult` 包络。PUT 失败返回相应 HTTP 错误与 error 包络；如果已经建立任务，查询端点另提供其 failed 状态。查询未知或到期的 transferId 返回 404 与 result-unknown，不能解释为没有写入。

上传的两个 ID 来自路由，parentId/name 来自 UTF-8 URL 查询参数，哈希/长度来自 ASCII 头，解析后组成 `CreateFileRequest`。根层 parentId 省略并映射为 null；空字符串、重复参数/必需头、非法百分号或非 UTF-8 编码必须失败，不能悄悄选取一个值或重复解码。name 编解码使用 URL 查询参数规则，不能放进原始 HTTP 头或路径段。具体请求解析由后续 HTTP 工作包实现。

长度头只允许非负十进制安全整数，`0` 有效；没有长度头映射为 null；不接受负数、指数、小数、空白或超范围值。HTTP Content-Length 表示传输定界，x-expected-size-bytes 表示本次内容校验，已知时两者必须一致；未知长度仍以正常流结束及哈希校验确认。下载头中的哈希需在发送内容前计算；流开始后的错误可能无法再发送 JSON，由接收方校验并核实实际结果。

| 错误码 | HTTP 状态 |
| --- | --- |
| invalid-request | 400 |
| protocol-mismatch、name-conflict、source-changed | 409 |
| permission-denied、authorization-expired、not-readable、path-outside-root | 403 |
| not-found、result-unknown | 404 |
| checksum-mismatch | 422 |
| insufficient-space | 507 |
| unsupported-operation | 501 |
| io-failure、cleanup-failed | 500 |
| network-failure | null，本地连接失败没有 HTTP 响应 |

`canRetry` 仅表示核实当前状态后可以让用户发起新操作，不允许自动重放写入。result-unknown 必须为 false。用户取消通过独立任务状态表达，不发明 499 状态码。映射依据 [HTTP 语义](https://www.rfc-editor.org/rfc/rfc9110.html)和 [507 存储不足语义](https://www.rfc-editor.org/rfc/rfc4918.html#section-11.5)。

## 4. 生命周期与跨语言责任

- `TransferProgress` 为 running，阶段只有 preparing、transferring、verifying、publishing。总量未知为 null；已传字节不能大于已知总量；校验/发布阶段即使字节传满仍未成功。
- `TransferReceipt` 的 succeeded 必须携带实际字节、本次哈希与最终文件元数据；已知目标大小应与实际字节一致。failed 带错误与可空 residualEntry，cancelled 带可空 residualEntry，unknown 只能带 result-unknown 错误。守卫不能证明文件已真正校验或发布，该责任属于适配器。
- Android 离开前台停止新任务并取消原生流；发布竞争按实际结果报告，unknown 不等于 failed 或未写入。回到前台重新读取当前目录并发起新任务，不恢复旧任务。服务仅保存会话内短期任务观察，到期或重启后重读当前目标，不保存长期传输账本。
- DTO 为只读快照，进程/桥之间通过 JSON 值传递，不传文件句柄、缓冲区或原生异常对象。Node 与 Kotlin 各自拥有本侧流、暂存文件、回调和监听，负责在成功、失败、取消、离开前台及退出时释放。
- Kotlin Long/时间值输出前须检查安全整数范围；未知使用 JSON null，不用缺失字段或字符串数字代替。UI 的监听者负责取消订阅，原生异步线程不得共享可变 DTO；需要时创建新的快照。
- `isPortableFileName` 是协议创建约束，依据 [Windows 文件命名规则](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file)制定；不保证提供者原子性、目标未存在或根内安全。实际同名竞争、真实路径检查和残留清理由平台实现。

## 5. 使用示例与检查

```ts
import { isDirectoryListing, isOperationResult } from '@savedata-sync/shared'

// payload 为已解析的 JSON；守卫不执行网络或文件操作。
function inspectListing(payload: unknown): string {
  if (!isOperationResult(payload, isDirectoryListing)) return '协议格式错误'
  if (payload.status === 'error') return payload.error.message
  return `当前层包含 ${payload.value.entries.length} 个条目`
}
```

- `pnpm test:shared`：用 Node 内置测试器及显式 `--experimental-strip-types` 执行运行时测试，无新增依赖。该开关支持项目功能最低 Node 22.13，仍应按仓库安全基线选择运行时。
- `pnpm --filter @savedata-sync/shared typecheck`：同时检查源码和类型反例；类型反例只参与编译，不执行。
- `pnpm check`：包含共享测试及双端构建；共享包显式只使用 ES2022 标准库、关闭自动平台类型注入，并启用 erasableSyntaxOnly，保证测试无需运行 TS 代码生成语法。

运行时测试覆盖 JSON 往返、空值、目录与错误区别、跨层清单、名称/ID 边界、进度与回执、取消/未知结果；类型反例覆盖只读数据和联合收窄。平台 IO、真实 HTTP、Android SAF、设备授权与前台生命周期的实际行为仍待后续包验证。
