# M-001 tar.gz 批量传输协议

## 目录

- [1. 状态与适用范围](#1-状态与适用范围)
- [2. 数据结构与校验](#2-数据结构与校验)
- [3. 归档格式与资源限制](#3-归档格式与资源限制)
- [4. HTTP 路由与会话](#4-http-路由与会话)
- [5. 双向流程与发布](#5-双向流程与发布)
- [6. 进度、结果与取消](#6-进度结果与取消)
- [7. 错误与资源所有权](#7-错误与资源所有权)
- [8. 验证场景与工作包交接](#8-验证场景与工作包交接)
- [9. 依据与设计取舍](#9-依据与设计取舍)

## 1. 状态与适用范围

更新日期：2026-10-27。协议使用 `protocolVersion=1` 及 `/v1`；v1 共享模型、双端私有归档、Windows HTTP sender/receiver 及批次非覆盖发布可用；Java 归档、实际 SAF 读取、原生跨端互通、lint 与双 APK 已通过。Android SAF 单文件发布、HTTP、任务编排、持续通知保持传输和独立界面均已完成，完整平台组合已通过真机验收。

双向唯一数据格式为 tar.gz，Windows 提供服务，Android Java 原生层主动请求。M-001 只在独立测试目录创建新文件；目标父目录必须已经存在，当前流程不创建目录、不覆盖、不镜像删除、不备份。可以从已有不同子目录中选择文件，但归档不展开目录树。完整同步目录映射和新建目录在 M-002 另行设计。

本文的清单、缓存、哈希、结果和已用任务 ID 都属于当前会话，只用于本次传输。目录浏览只列当前层，不为文件夹大小递归扫描。没有待传文件时，本地显示无需传输，空批次不会建立。超出单批限制时明确拒绝；自动拆批和跨批重试不在 M-001 内。

双端归档及 Windows HTTP sender/receiver 与批次发布已通过原生验证；WP-013 连同实际 SAF 读流和设备测试一起完成。Android 原生构建与 JVM/Windows 互通可无设备执行；实际 SAF 归档使用系统 READ 选择器与独立合成源，发布使用系统 WRITE 选择器与另一独立合成目标，控制文件前后核对；实际 API 33 正式 LAN 双向、通知保持后台传输与 Activity 重连已由 WP-006 完成。归档故障测试仅使用独立合成夹具与私有缓存。

## 2. 数据结构与校验

所有 JSON 对象为封闭结构；字段必须存在，只有明示的字段允许 null；未知字段、重复 JSON 键、非法 UTF-8、未配对代理项、非有限或非安全整数会被拒绝。解析层负责重复键检查，数据守卫只校验解析后的对象。沿用现有 ID、名称、SHA-256、元数据、`OperationError` 及互斥 `OperationResult<T>` 语义；新增错误见第 7 节。文件名只在 JSON 中传输，不放入 HTTP 头或归档路径。

| 数据结构 | 字段及语义 |
| --- | --- |
| BatchDeviceDescriptor | `device: DeviceDescriptor`（保持现有本地设备 DTO）、`sessionId: ID`、`limits: BatchLimits`；替换 HTTP device 响应值，不更改现有本地目录桥的返回形状 |
| BatchLimits | 第 3 节各项具名限制；字段为 `maxFiles`、`maxFileBytes`、`maxTotalFileBytes`、`maxTarBytes`、`maxArchiveBytes`、`maxJsonBytes`、`maxConcurrentBatches`、`maxTransfersPerSession`；均为正安全整数；本期两端使用固定相同常量，不允许请求自行放宽 |
| DownloadBatchRequest | `protocolVersion: 1`、`transferId: ID`、`sourceRootId: ID`、`files: SourceSelection[]`；方向固定 windows-to-android |
| SourceSelection | `fileId`、`entryId`；只选择当前 sourceRootId 中的普通文件，引用重复即拒绝；不接受目录、路径或 URI |
| PreparedFile | `fileId`、`sourceEntryId: ID`、`sourceParentId: ID或null`、`sourceName: 展示文本`、`sourceModifiedAt: Unix毫秒或null`、`sizeBytes: 实际非负整数`、`sha256: 本次内容哈希`；未知源长度在准备阶段实测，不能出现在已准备清单中 |
| ArchiveDescriptor | `format: 'tar.gz'`、`compressionLevel: 1`、`sizeBytes: 压缩体实际长度`、`tarSizeBytes: 未压缩tar实际长度`、`sha256: 整个gzip字节序列哈希` |
| BatchManifest | `protocolVersion: 1`、`transferId: ID`、`sourceDeviceId: ID`、`sourceRootId: ID`、`files: PreparedFile[]`、`totalFileBytes: 文件实际长度之和`、`archive: ArchiveDescriptor` |
| TargetSelection | `fileId`、`parentId: ID或null`、`name: 合法单文件名`；root 由批次的 targetRootId 给出；不接收相对路径 |
| ReceiveBatchRequest | `protocolVersion: 1`、`manifest: BatchManifest`、`targetRootId: ID`、`targets: TargetSelection[]`；HTTP 上传方向固定 android-to-windows；Android 本地接收也使用同一数据语义 |

`fileId` 是批内索引：严格为 `f000001` 至 `f001024`，按 files 数组从 1 连续编号。它不是源文件名或条目 ID。targets 可以按不同顺序提供，但必须与清单 fileId 一一对应，不能缺失、重复或附加成员；发布顺序固定为清单顺序。sourceEntryId 在同一批次不重复。两个源文件若计划映射到同一个目标位置必须拒绝，不允许后项覆盖前项。

清单中的 sourceRootId/sourceEntryId 只用于源端验证及结果关联；接收端只通过自身 targetRootId 和 parentId 访问目标。目标端会重新核实授权、实际父目录身份和当前名称冲突。完全相同的目标引用/名称在纯守卫中拒绝；Windows 大小写等价、不同 parentId 指向同一目录以及 SAF 的名称等价由平台适配器检查，JavaScript 字符串比较只能排除完全相同的值。

源名称沿用展示文本规则，目标 name 沿用共同创建约束（最多 255 个 UTF-16 码元，不改名或归一化）。目标端无法表示的名称会在写入前拒绝，不做静默替换。文件的 sourceModifiedAt 是本次源观察信息，不决定方向，也不要求目标保留它；界面展示目标实际元数据。

结构守卫分别校验清单、请求和状态本身。状态本身不含原始清单或目标映射，因此 `matchesBatchState(value, manifest, direction, receiver?)` 用本次明确方向及清单对照；receiver 必须提供完整 ReceiveBatchRequest，检查全部 fileId、字节/哈希、目标 rootId/parentId/name 和结果数量；接受接收成功前必须执行该检查。`isBatchProgressAdvance` 检查同任务进度单调、已知总量不改写，任务身份与时间先后由调用方核实。平台层仍负责实际身份、IO 和最终回读。

例如只传一个空文件时，SourceSelection 为 fileId=f000001 及其源 entryId，PreparedFile 的 sizeBytes=0，sha256 为 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`；对应 tarSizeBytes=1536。目标可映射为已有目标根的 parentId=null、name=“存档 01.sav”。archive.sizeBytes/sha256 必须由该次实际打包计算，示例值不能直接作为线数据。receiver 成功仍要求创建并回读这个空文件，即使 totalFileBytes=0 也要完成发布。

## 3. 归档格式与资源限制

| 限制 | M-001 固定值 | 执行位置 |
| --- | --- | --- |
| maxFiles | 1,024；实际 files 长度必须为 1–1,024 | 准备、清单守卫、解包 |
| maxFileBytes | 256 MiB = 268435456 | 源实测、清单、tar 头和实际解包计数 |
| maxTotalFileBytes | 1 GiB = 1073741824 | 文件长度求和和实际解包计数 |
| maxTarBytes | 1 GiB + 1 MiB = 1074790400 | 解压输出总计数，包含所有 tar 头、填充与结束块 |
| maxArchiveBytes | 1088 MiB = 1140850688 | 打包输出、HTTP 原始体和接收缓存 |
| maxJsonBytes | 8 MiB = 8388608；请求及单个 JSON 响应分别限制，解码前计 UTF-8 字节 | HTTP 解析及序列化 |
| maxConcurrentBatches | 每端进程 1 个活动批次，含准备、等待内容、ready、传输、校验、发布及清理；不限制只读查询 | 原生任务调度 |
| maxTransfersPerSession | 每服务会话最多 4,096 个已接纳 ID，终态到期后仅保留 ID 防重用 | Windows 会话注册表 |
| 暂存空间 | 每端任务拥有的文件实际总量最多 3 GiB = 3221225472；全部阶段累计约束 | 原生缓存计数及磁盘空间检查 |
| 缓冲与并发 | 应用显式文件读写缓冲每条最多 64 KiB，逐文件处理；按文件流式读写，不把整批或整文件收进内存 | 双端归档与 HTTP 适配；库内部开销另测，64 KiB 不包含库的内存占用 |

首轮实现采用这些保守技术预算，产品规模上限还没定。满额 1 GiB 双向和进程内存实测见[规模验收](../validation/m001-resources.md)，用户取消功耗计算，本轮不做磁盘耗尽注入。发送端先在私有目录按流暂存每个源文件并计算实际长度与 SHA-256，再从只读暂存构造归档；接收端保存压缩体后流式解包至私有文件。每次接收在内容流开始前检查缓存与可取得的整批目标余量；Windows 缓存与目标同卷时合计峰值，SAF 未报告容量时保留未知。gzip 的 ISIZE 只作格式校验，超限判断使用实际计数；传输期间继续检查余量并按实际 IO 错误处理。

归档采用受限 USTAR 格式，不接受任意用户 tar 文件：

1. 每个普通文件恰好一个 512 字节 USTAR 头，typeflag 固定 ASCII `0`；name 恰为 fileId，余下 name 字节填零；prefix 和 linkname 全零。magic 为 `ustar` 加 NUL，version 为 `00`。拒绝链接、目录、设备、FIFO、PAX、GNU 长名、稀疏文件、base-256 数值和任何其他扩展。
2. mode 为八进制 0600，uid/gid/mtime 为 0，用户名/组名为空，设备字段为 0；归档不包含真实机器路径、属主或源时间。数值字段以非负 ASCII 八进制编码，发送端用零补齐并以 NUL 结束；checksum 使用六位八进制加 NUL、空格，计算时将该字段视为空格。接收端验证头校验和、字段终止及全部限制，成员名校验只是其中一项。
3. 成员按清单顺序出现。size 必须等于 PreparedFile.sizeBytes，实际内容紧随头部并补零到下个 512 字节边界；填充必须为零。最后恰好两个全零块（1024 字节），不接受附加记录填充或隐藏成员。tarSizeBytes 必须等于 `Σ(512 + ceil(sizeBytes / 512) × 512) + 1024`；其上界不超过表中 maxTarBytes。
4. tar 外层为一个 gzip member：CM=8、FLG=0、MTIME=0，不包含可选文件名、额外字段或注释；XFL/OS 不作为跨平台相等条件。发送端采用 gzip level 1；接收端只验证能否解码，无法从压缩字节可靠反推 level。严格验证 DEFLATE 结束、CRC32、ISIZE 及输入恰好消费完毕；拼接的第二个 gzip member、尾随字节、截断或损坏都会拒绝。ISIZE 只作格式校验，实际长度以受限计数为准。
5. 对压缩体和每项原文分别计算 SHA-256，全部与清单匹配；CRC32 只校验 gzip 传输完整性，内容身份使用 SHA-256。两端压缩器可能输出不同字节，archive.sha256 只对应本次已准备的归档，不要求重新压缩后相同。

接收端以清单 fileId 在自己创建的私有任务目录分配文件，tar name 不交给通用 extract-to-path API；目标发布也只使用 TargetSelection。解压缩要可中断并持续检查上限；通用解码器允许拼接 gzip 或忽略 tar 尾部时，适配层要补充校验。

## 4. HTTP 路由与会话

服务启动时生成新的不透明 sessionId；与稳定 deviceId 分离。除 GET /v1/device 外，所有请求都必须且只提供一个 `x-sync-session-id`，值精确匹配当前会话；这是重启检测标识，不是认证凭据。只允许本机用户已经登记的根目录；接收必须另具显式写授权，读取登记不自动变成写授权。

| 方法和路径 | 输入 | 成功响应及含义 | 负责包 |
| --- | --- | --- | --- |
| GET /v1/device | 无 | 200，OperationResult<BatchDeviceDescriptor>；device.protocolVersion 必须为数字 1 | WP-004 |
| GET /v1/roots | 会话头 | 200，现有根目录列表包络 | WP-004 |
| GET /v1/roots/{rootId}/entries | 会话头；可选 parentId，省略为 null | 200，现有 DirectoryListing 包络，仅当前层 | WP-004 |
| POST /v1/transfers/downloads | 会话头；DownloadBatchRequest JSON | 202，OperationResult<BatchState>；任务已登记并异步准备，归档是否就绪看后续查询 | WP-004 |
| GET /v1/transfers/{transferId}/manifest | 会话头 | 200，OperationResult<BatchManifest>，只在准备好后或尚保留清单的终态可取；未 ready 返回 task-conflict | WP-004 |
| GET /v1/transfers/{transferId}/content | 会话头；只允许 sender ready 的任务 | 200，application/gzip 原始体；表示 sender 开始发送，发布结果看 receiver 状态 | WP-004 |
| POST /v1/transfers/uploads | 会话头；ReceiveBatchRequest JSON | 201，OperationResult<BatchState>；接收任务已进入 awaiting-content，文件是否发布看后续查询 | WP-005 |
| PUT /v1/transfers/{transferId}/content | 会话头；只允许 receiver awaiting-content；application/gzip 原始体 | 202，OperationResult<BatchState>，完整压缩体已收齐并通过压缩体长度/哈希检查，异步解包及发布；须查询实际终态 | WP-005 |
| GET /v1/transfers/{transferId} | 会话头 | 200，OperationResult<BatchState>；查询请求成功，文件结果看 BatchState | WP-004 建立通用注册表，WP-005 处理接收状态 |
| DELETE /v1/transfers/{transferId} | 会话头 | 活动任务请求取消返回 202，终态返回 200；均返回实际 BatchState，已经发布的文件保留 | WP-004 建立通用取消，WP-005 处理接收取消 |

JSON 使用 application/json，成功与错误均遵循现有互斥包络。数据体的 gzip 是传输的文件表示，不设置 `Content-Encoding: gzip`；原生 HTTP 客户端不得自动解压或跟随重定向。不接受 Range、续传或 multipart。控制/状态/归档响应设置 `Cache-Control: no-store`。

GET content 响应及 PUT content 请求均须提供唯一的 Content-Length 和 `x-archive-sha256`，精确等于已登记 manifest.archive 的实际压缩体长度和哈希。二者在数据开始前即可得知；拒绝 Transfer-Encoding、重复/冲突头和非法十进制长度。读取精确长度及正常消息结束后仍验证原始体 SHA-256；流中失败时关闭连接并登记失败。JSON 体允许固定长度或合法 HTTP 定界的流式接收，但按 maxJsonBytes 硬限计数，不接收 Content-Encoding；歧义定界必须失败并关闭连接。

路由 ID 和 parentId 解码一次；拒绝未知/重复查询参数、非法编码、附加路径段和错误 method。参数名与数据字段不可强制转换。文件名不经 URL 二次解码，JSON 字符串中的百分号就是名称的一部分。相同会话内 transferId 是单次任务身份：原子登记后即占用，POST 重复不重新执行；content 只允许原子领取一次，重复/错误方向/错误阶段为 task-conflict。接纳前的格式错误不占用 ID；接纳后的失败、取消、结果到期均不允许重用该 ID。

准备完成的 sender ready 最多等待 10 分钟；receiver awaiting-content 最多等待 2 分钟。任务自接纳起总期限 30 分钟；网络传输连续 60 秒无数据进展终止。到期设置明确 timeout 失败并清理未发布资源，不会通过轮询延长期限。实际进入发布的平台调用若无法立刻中断，保留清理/待确认状态，不提前释放写入互斥锁。

终态及清单保留 10 分钟供核实，之后清除内容、哈希、清单和逐文件结果；同会话只保留有限的已用 ID 集合。到期或从未登记的查询均为 404/result-unknown；旧 sessionId 在服务重启后为 409/session-mismatch。遇到这两种情况时，远端可能已经写入，要重新读取目标确认。达到会话 ID 上限后拒绝新任务并提示重新启动服务，防重记录不会被丢弃。Android 同时清理本地会话结果，离开前台不恢复旧任务。

## 5. 双向流程与发布

### Android → Windows

1. Android 在前台重新核实源引用，按流复制已选源文件到应用私有原文暂存，计算实际长度/哈希；检查可获得的读取前后身份、大小与修改时间，检测到变化立即失败。实际选择目标根/父目录及名称，与源名分开。
2. 从私有原文暂存生成 tar.gz 缓存并计算归档长度/哈希，再形成完整清单。源元数据未知时允许实际计数；不先相信未知长度来分配内存。准备后不再重新打开原源文件发送另一份内容。
3. POST uploads 登记任务，Windows 校验清单及全部目标，获取该目标根的接收互斥，确认写授权与当前冲突；任务进入 awaiting-content。拒绝前不触碰目标。
4. PUT content 上传唯一归档。Windows 在私有目录保存并验证整个压缩体，然后解包、验证所有成员及原文。任何归档或原文校验错误都在目标发布前终止，所有文件记为未尝试。
5. 全部校验成功后按清单顺序通过 WP-009 发布，每次发布前重查父目录、授权及目标冲突。逐项回读目标内容，确认实际名称、字节数、EOF 和 SHA-256；成功后才记录文件成功。首次发布失败即停止后续文件，保留已成功文件，反馈失败/未尝试/残留。
6. Android 查询直到 Windows 终态；响应丢失时只查询，不重发 POST/PUT。查询结果不确定时，重读当前目标并提示用户核实，不自动重试写入。

### Windows → Android

1. Android POST downloads 指定 Windows 已登记根内的显式文件引用，Windows 异步准备私有原文快照及 tar.gz，执行与上行相同的计数/源变化检查；返回 ready 后 Android GET manifest。
2. Android 验证清单及全部本地 TargetSelection、写授权、空间和当前冲突，才 GET content。Windows 只发送已准备归档；源文件之后的变化不改变这份任务快照。
3. Android 在私有目录保存、完整校验压缩体及所有原文，再使用 WP-010 对 SAF 逐项新建、写入、关闭并回读；校验实际名称、内容和实际元数据后报告各文件结果。
4. Windows 只记录 sender 的 sent/failed/cancelled/unknown，不推断手机已发布。最终文件结果由 Android receiver 的本地 BatchState 提供；本期不增加回传成功确认或 Windows 发起任务通道。

准备阶段复制的是本次所选文件的内容快照。读取前后的可观察属性变化会导致失败；同大小且 mtime 不变的改写可能漏过，多个文件也可能来自不同时刻。测试夹具保持静止；后续产品要提示同步时退出游戏。哈希匹配只证明文件内容与本次清单一致，不构成跨文件原子快照。

Windows 发布必须使用不会替换既有目标的原语，并验证“检查后出现目标”的竞争；先检查再 rename 覆盖的实现不符合要求。SAF 没有通用的同名排他创建保证：创建前后重查实际条目及名称，只操作本次确知新建的 document URI；提供者改名、同名歧义、身份不明，或无法保证不改写既有文件时，停止操作或报告待确认。createDocument 之后还要核对实际条目、名称和回读结果，才算完成非覆盖发布。

## 6. 进度、结果与取消

| 模型 | 字段及约束 |
| --- | --- |
| BatchState 基础字段 | `transferId`、`direction: windows-to-android或android-to-windows`、`role: sender或receiver`、`updatedAt: Unix毫秒`；direction 表示实际数据方向，role 表示当前报告端的职责 |
| running 分支 | 基础字段 + `status: 'running'`、`stage`、`progress: BatchProgress`、`cancelRequested: boolean`、`fileResults`；sender 的 fileResults 固定 null，receiver 为已完成的逐文件结果子集，无重复 fileId |
| 终态分支 | 基础字段 + `status`、`error`、`fileResults`、`cleanupStatus`、`cleanupError`；不再带 stage/progress/cancelRequested；error/cleanupError 为 OperationError或null，文件结果规则见下文 |
| BatchProgress | `sourceBytesRead`、`archiveBytesTransferred`、`fileBytesVerified`、`fileBytesPublished`、`totalFileBytes: 整数或null`、`totalArchiveBytes: 整数或null`、`totalFiles`、`verifiedFiles`、`publishedFiles`；其余为非负安全整数；本任务内单调递增，计数不得超出已知对应总量 |
| 文件成功 | `fileId`、`status: 'succeeded'`、`bytesWritten: 实际整数`、`sha256`、`entry: FileMetadata`；entry 是回读确认后的实际目标条目，已知大小必须与 bytesWritten 相符，哈希/字节须与该清单项一致 |
| 文件失败 | `fileId`、`status: 'failed'`、`error: 非result-unknown错误`、`residualEntries: EntryReference[]`；仅列本次新建但未清理的条目，不指向任务前已有条目 |
| 文件取消 | `fileId`、`status: 'cancelled'`、`residualEntries: EntryReference[]`；仅用于已经开始但被实际中止的本项 |
| 文件未尝试 | `fileId`、`status: 'not-attempted'`、`reason: 'batch-invalid'或'prior-failure'或'cancelled'`；目标创建还没开始，可以确认没有写入 |
| 文件待确认 | `fileId`、`status: 'unknown'`、`error: result-unknown且canRetry=false`、`residualEntries: 已知引用数组`；数组为空说明没有已知残留 |

stage 为 preparing、ready、awaiting-content、transferring、verifying、publishing、cleaning；sender 正常顺序为 preparing → ready → transferring → sent，receiver 为 awaiting-content → transferring → verifying → publishing → cleaning → succeeded。Android 本地接收可以在 preparing 校验本地目标后进入 transferring。取消/失败可从任意活动阶段进入 cleaning 后终结；ready 表示归档已准备，文件发布结果还没产生。

sourceBytesRead 只计从源拷贝到私有原文快照的字节，不计压缩器重读；archiveBytesTransferred 计 gzip HTTP 数据体，不计头和控制 JSON；fileBytesVerified 只计首次私有原文校验；fileBytesPublished 只在逐项最终回读确认成功时增加该文件完整长度，失败项的尝试写入量不计入。sender 的校验/发布计数保持 0，receiver 的 sourceBytesRead 为 0。准备前总量可为 null，准备后分别为 manifest.totalFileBytes/archive.sizeBytes；totalFiles 为本批选中数量。全是空文件时 totalFileBytes=0 合法，不计算原文字节百分比；这些任务是本次传输总量，与文件夹大小无关。

终态规则：

- sender 只允许 sent、failed、cancelled、unknown。sent 的 error=null、fileResults=null，表示本机 HTTP 数据已经发送；对端是否收到或发布，要看 receiver 结果。sender 不使用 succeeded。其余终态的 fileResults 也为 null；failed 必须携带非 result-unknown 的实际错误，cancelled 的 error=null，unknown 必须使用 result-unknown。
- receiver 允许 succeeded、failed、cancelled、unknown；终态 fileResults 必须按清单顺序覆盖每个 fileId 恰好一次。全项成功才为 succeeded，error=null；已成功文件不因后来取消而改成取消。
- 若有结果无法确认则批次为 unknown/error=result-unknown；否则存在失败或批次准备/校验失败则 failed/error=实际原因；否则因取消未全部发布则 cancelled/error=null；否则 succeeded。归档整体验证失败时全部文件为 not-attempted/batch-invalid。
- `cleanupStatus` 为 not-needed、complete、incomplete 或 unknown；cleanupError 在 incomplete 时必有 cleanup-failed，在 unknown 时为 result-unknown，其余为 null。发布成功但私有缓存清理失败时仍保留 succeeded/sent，并明确 cleanupStatus=incomplete。发布状态无法确认时使用 unknown。

取消设置 cancelRequested，关闭网络与可关闭的文件流，阻止新发布；若一次平台发布已不可中断，等待该操作并回读其实际结果，再清理当前未完成的新建项。不得删除已确认成功的最终文件或任何原有文件。Android 切后台或 Activity 销毁不取消已有传输，应用级任务由持续通知/dataSync 前台服务持有；界面返回时查询同一任务，不重新启动。用户显式取消或任务期限到达时关闭本地流并尽力发送远端 DELETE；远端取消回执不确定时须核实，不自动重放。Windows 最终受期限控制，不因界面状态变化就凭空确认取消或发布成功。

## 7. 错误与资源所有权

| 错误 | HTTP 映射 | 行为 |
| --- | --- | --- |
| invalid-request | 400 | JSON/字段/UTF-8/重复键、定界、头或参数非法 |
| protocol-mismatch、session-mismatch、task-conflict、name-conflict、source-changed | 409 | 版本、会话、任务占用/阶段或源/目标冲突；session-mismatch 的 canRetry=false，不重放旧操作 |
| permission-denied、authorization-expired、not-readable、path-outside-root | 403 | 沿用原错误语义 |
| not-found、result-unknown | 404 | 目录/条目不存在与结果未知分开；result-unknown 固定 canRetry=false |
| invalid-archive、checksum-mismatch | 422 | 归档成员/格式非法与内容校验失败分别表达 |
| resource-limit | 413 | 声明或实际字节/成员/JSON 超限，及时终止读取 |
| busy | 429 | 已有活动批次或会话 ID 容量耗尽；提示用户等待/重新启动服务，不自动重试写入 |
| timeout | 408 | 服务尚能回复时返回；连接已断则只登记失败状态，客户端可能仅观察到 network-failure |
| unsupported-operation | 501 | 能力未实现或提供者不支持安全发布 |
| insufficient-space | 507 | 私有或目标存储空间不足 |
| io-failure、cleanup-failed | 500 | IO 及清理失败分开记录；清理错误独立于已经确认的文件结果 |
| network-failure | 无 HTTP 状态（null） | 客户端本地连接失败；远端可能已经写入，要重新读取目标确认 |

共享错误联合与映射包含 session-mismatch、task-conflict、invalid-archive、resource-limit、busy、timeout。统一 canRetry 语义是“核实当前状态后由用户建立新操作”，自动重放不在范围内；取消使用任务状态，不新增 499。已登记的任务失败由查询返回 200 的实际 failed 状态；HTTP 控制请求错误使用 error 包络，与文件结果分开检查。

平台原生层拥有文件句柄、压缩器、HTTP 流、私有缓存和任务注册表；WP-012/WP-013 仅提供归档与缓存能力，WP-004/WP-005/WP-006 编排网络和任务。IO 在主 UI 线程外执行；批次状态由单一任务所有者串行更新，查询返回只读快照。取消信号跨层传播，每层释放自己持有的资源，不把 InputStream/Readable、缓冲区、URI 或本机路径跨 JS 桥传递。

每个任务缓存带内部所有权标记并位于固定应用私有缓存根；完成/失败/取消/超时都尝试清理。重启只清理可验证为本应用所有的孤儿缓存，不依据外部归档路径或旧 ID 删除任意文件；不重建旧任务结果、不继续传输。无法清理时阻止超出暂存预算的新任务并报告缓存问题。目标残留仅通过本次确知新建的引用清理；归属不确定时不删除，报告待确认。

## 8. 验证场景与工作包交接

| 场景 | 核心断言 | 主要工作包 |
| --- | --- | --- |
| DTO、封闭联合与字段关系 | 非法/额外/缺失字段；清单求和、边界整数、fileId 连续性、目标一一对应、角色终态和计数约束；本地目录 DTO 继续通过 | 共享模型 |
| 跨平台固定归档夹具 | 空文件、中文/空格/非 BMP 目标名、同名源分属不同已有目录、超过缓冲的内容；两端消费同一独立期望夹具，不只做各自 writer/reader 自我往返 | WP-012、WP-013 |
| 归档畸形 | 穿越/绝对路径/重复/遗漏/乱序/额外成员、链接和扩展、坏头/填充、额外结束块、gzip 拼接/尾随/CRC 错误/截断 | WP-012、WP-013 |
| 资源上限 | 每个上限恰好等于及超过 1；未知源长度实际超限；高压缩比但合法的文件允许；解压绝对超限或超时中断；空间不足与缓存清理失败 | WP-012、WP-013，HTTP 包补网络限流 |
| HTTP 状态与防重 | 重复 JSON 键/请求头/参数、错误会话、同 ID 并发 POST、重复 content、状态到期和 ID 不复用、重启、端口冲突、错误方向、响应丢失 | WP-004、WP-005 |
| 发布和取消 | 全部校验前无目标写入；同名竞争不改原有文件；第 k 项失败/取消保留前项成功并标明后项未尝试；SAF 改名/歧义/残留；取消请求丢失时标为待确认 | WP-009、WP-010、WP-005、WP-006 |
| 真机/前台/实际 LAN | Android API 29 和较新系统，真正 SAF 新建及写后回读，通知保持后台继续与显式取消及长文件/多个文件往返；用实际 LAN 验证，ADB 只负责部署和检查状态 | WP-006、WP-008 |

共享批量模型、双端私有归档、Windows HTTP sender/receiver 和原生新文件发布已完成。Windows/Java 共用独立 Python 格式夹具，执行失败场景与原生双向互通；WP-013 的 API 33 设备还验证实际 SAF 四文件快照、子目录/同名/未知长度、取消/复用及源保护，并由 Windows 独立解包比对上传原文。API/缓存释放说明见[桌面说明](../../apps/desktop/README.md)与[移动说明](../../apps/mobile/README.md)。WP-004/005/006 编排归档，WP-009/010 负责目标发布；网络与 SAF 发布分别验收。

WP-008 已完成满额双向、进程内存与每次传输容量预检，M-001 已收尾；结果见[规模验收](../validation/m001-resources.md)，完整依赖与代码范围见[工作包登记](../../.project-memory/development/work-packages.md)。

## 9. 依据与设计取舍

gzip 格式的 header、DEFLATE、CRC32 和 ISIZE 依据 [RFC 1952](https://www.rfc-editor.org/rfc/rfc1952)。本协议主动限制为单 member、无可选头和无尾随内容，严格于通用 gzip 接收能力。HTTP 202 表示已接纳、处理还在进行，413 表示内容超出接收限制，依据 [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html)；具体路由、错误联合、预算及任务状态均为本项目设计。

采用 gzip level 1 是本项目当前在速度、CPU 和体积之间的折中；全部设备上的表现还要实测。归档正确性由本协议规定的固定格式和跨端夹具验证。

先原文暂存再打包，会增加一次私有磁盘 IO，换来未知长度文件的确定长度、稳定哈希和可验证的发送内容，同时保持有限内存。归档名使用 ID，名称保留在清单/目标映射中，避开跨平台 tar 文件名编码与路径展开；发布端因此需要持有本次清单。是否在后续实现中降低暂存 IO 或提高批次规模，要先拿到资源和失败场景的实测证据，同时保留完整校验及非覆盖发布边界。
