---
doc_type: api-contracts
status: active
priority: medium
owner: architecture
updated: 2026-10-26
tags: [API, 接口契约]
related_files: []
---

# 接口契约

## 目录

- [1. 状态与范围](#1-状态与范围)
- [2. 共用数据语义](#2-共用数据语义)
- [3. Windows HTTP 接口约定](#3-windows-http-接口约定)
- [4. 本地桥与错误边界](#4-本地桥与错误边界)
- [5. 版本与线格式](#5-版本与线格式)
- [6. 已实现检查与验证边界](#6-已实现检查与验证边界)

## 1. 状态与范围

版本 1 本地/批量共享契约、双端目录读取、双端私有归档与 Windows HTTP sender/receiver 及非覆盖发布已实现。WP-013 已完成 Java 实际 SAF 原生读流集成，验证见 TC-032；Android SAF 单文件发布已实现，接口与实际设备验证见 TC-034；Android HTTP 客户端尚未实现。平台说明见 `apps/desktop/README.md`、`apps/mobile/README.md`，共享字段与线格式见 `packages/shared/README.md`；范围与依赖见[工作包](../development/work-packages.md)。

M-001 只验证专用测试目录内的新文件往返，不包含同步项目 CRUD、覆盖、镜像删除、备份、mDNS 或 Windows 发起任务的控制通道。Windows 为服务端，Android 原生层为 HTTP 客户端。

用户已在[Q-008](../requirements/open-questions.md)确定双向统一采用 tar.gz。完整设计位于仓库根目录的 `docs/plans/m001-tar-gzip-protocol.md`；v1 批量共享数据与双端私有归档编解码已实现。Windows 已实现 v1 读取/sender 与上传/receiver 端点，不提供单文件兼容别名；Windows 原生新文件发布及批次编排已实现；Android 原生新文件发布已实现，下一 WP-006 Android 网络。

独立调试协议已在真实 LAN 完成 54 组双向与 SAF 写后回读实验，结果见 `docs/experiments/transfer-benchmark-2026-10-26.md`。实验未交付正式批量端点或归档接收适配，也不自动符合受限归档格式。共享数据校验通过不代表实际归档、HTTP 或目标文件发布通过。

## 2. 共用数据语义

| 模型 | 当前字段与约束 |
| --- | --- |
| DeviceDescriptor | protocolVersion=1、deviceId、displayName、platform、capabilities；稳定 ID 与地址分离 |
| DirectoryReference | rootId、deviceId、displayName、authorization；授权状态 granted/expired/unavailable/unverified，不包含绝对路径或 content URI |
| EntryMetadata | rootId、entryId、parentId、name、kind、sizeBytes、modifiedAt、capabilities；file/directory 联合；根层 parentId=null，不能自引用；文件夹大小恒为 null，文件未知大小为 null，空文件为 0 |
| DirectoryListing | rootId、parentId、observedAt、entries；成功空数组表示空目录；条目须属于同一根/层且 ID 不重复；错误用独立包络 |
| EntryCapabilities / DeviceCapabilities | 条目能力 canRead/canList/canCreate/canRename/canDelete；设备能力 canListRoots/canReadFiles/canReceiveFiles/canQueryTransfers/canCancelTransfers；各值 supported/unsupported/unknown |
| OperationError / OperationResult | code、message、canRetry；互斥 success/value 与 error/error 包络；result-unknown 的 canRetry 必须为 false；错误消息由生产者脱敏 |
| DirectorySelectionResult | selected 携带 directory，cancelled 不携带目录或错误，error 携带错误；取消不清空既有有效引用 |
| BatchDeviceDescriptor | 已实现共享声明：包装既有 device，加 sessionId 和固定 limits；不改本地目录桥返回值 |
| BatchManifest / TargetSelection | 已实现 DTO/关系守卫：源引用、连续 fileId、实测长度/哈希及精确 tar 求和；目标在已有父目录以单文件名一一映射，不展开归档路径 |
| BatchProgress / BatchState / FileOutcome | 已实现角色/阶段/计数和结果聚合守卫；sender sent 不代表 receiver succeeded；逐项成功/失败/取消/未尝试/未知与清理状态分开 |

M-001 不要求所有提供者保留源修改时间；写入后查询并展示目标实际元数据。同路径、同大小或同日期均不能替代内容校验。

## 3. Windows HTTP 接口约定

以下 v1 路由常量及 DTO 已由共享包导出；Windows 读取/sender、uploads/PUT receiver 及通用查询/取消端点已实现；完整字段、状态码和例外以仓库根目录的 `docs/plans/m001-tar-gzip-protocol.md` 为准。WP-012/WP-013 分别实现双端归档，网络包只编排这些能力。

| API | 方法 | 请求 | 响应 | 错误边界 | 工作包 |
| --- | --- | --- | --- | --- | --- |
| /v1/device | GET | 无 | BatchDeviceDescriptor：device、sessionId、limits | 版本不兼容时客户端停止文件操作 | WP-004 |
| /v1/roots | GET | 无 | 本机用户已经选择用于本次验证的根目录描述 | 不枚举其他主机目录 | WP-004 |
| /v1/roots/{rootId}/entries | GET | 可选 parentId；省略表示根层 | 当前层条目及读取时间 | 非法引用、目录失效、不可读与空目录分别表达 | WP-004 |
| /v1/transfers/downloads | POST | DownloadBatchRequest | 202，已接纳的 sender 状态 | 异步准备不等于 ready 或目标成功 | WP-004 |
| /v1/transfers/{transferId}/manifest | GET | 已准备的任务引用 | 200，本次 BatchManifest | 未准备好冲突，不读取另一会话清单 | WP-004 |
| /v1/transfers/{transferId}/content | GET | sender ready 任务引用 | 200，application/gzip 原始体 | 单次领取；发送失败与手机实际发布结果分开 | WP-004 |
| /v1/transfers/uploads | POST | ReceiveBatchRequest：清单、目标根和逐项目标映射 | 201，已登记的 receiver 状态 | 登记不等于发布，不覆盖已有文件 | WP-005 |
| /v1/transfers/{transferId}/content | PUT | 已登记清单对应的唯一 gzip 原始体 | 202，压缩体收齐且长度/SHA-256 匹配的 verifying 快照，异步解包校验/发布 | 全部校验前无目标写入；断流/取消/部分发布如实反馈 | WP-005 |
| /v1/transfers/{transferId} | GET | 本次会话任务 ID | 200，运行阶段或实际结果 | 不存在/到期不等于未写入；须重读当前目标核实 | WP-004 通用注册表；WP-005 接入接收 |
| /v1/transfers/{transferId} | DELETE | 取消本次任务 | 活动 202 / 终态 200，实际状态 | 与发布竞争时如实返回结果；不删除已发布最终文件 | WP-004 通用取消；WP-005 接入接收 |

路由参数、任务清单和归档条目都必须验证。parentId 是目录引用，name 只能是单个合法文件名；归档成员必须与本次清单一致，拒绝绝对路径、路径穿越、重复成员及链接越界，不能直接按归档路径写盘。Windows 解析引用时仍须校验真实根目录边界，拒绝符号链接/junction 越界；不接受主机绝对路径。共享守卫只检查数据，不替代平台权限、实际路径与名称竞争检查。

双向使用 gzip level 1 + 受限 USTAR，成员名仅为连续 fileId。固定预算为每批最多 1024 文件、单文件 256 MiB、原文合计 1 GiB、压缩体 1088 MiB、解压 tar 1 GiB+1 MiB、JSON 8 MiB、私有暂存 3 GiB；每端仅一个活动批次，显式 IO 缓冲不超过 64 KiB。未知源长度先私有暂存实测；接收端完整验证压缩体、tar 结束及全部逐文件内容后才发布。首次发布失败停止后续，保留既有成功项并列出残留，不承诺整批原子性。SAF 若不能保证不修改既有条目则拒绝或待确认，不能假定 createDocument 为排他创建。

transferId 不表示历史同步基线。服务以每次启动的 sessionId 隔离任务，除设备描述外要求 x-sync-session-id；同会话 ID 不复用，content 只领取一次。ready 等待 10 分钟，接收等体 2 分钟，总期限 30 分钟，网络无进展 60 秒终止；终态保留 10 分钟，随后清除清单/哈希/结果，仅保留最多 4096 个已用 ID。服务重启或响应/结果丢失都不能证明未写入，不自动重放旧任务。

## 4. 本地桥与错误边界

| 边界 | 允许传递的内容 | 禁止或限制 |
| --- | --- | --- |
| Electron preload（已实现） | chooseDirectory、listRoots、listDirectory；只接受 ID，返回公开 DTO；系统选择器在主进程执行 | 无 fs/shell/Node、绝对路径、内容或写入接口；校验登记窗口、主 frame 与精确 URL；退出移除 handler |
| Electron 主进程原生读取（已实现） | registerDirectory 登记系统选中路径，listDirectory 返回当前层，openFile 返回本进程只读流 | 配置独立存放，不保存历史清单；调用者消费或 destroy 流；逐段拒绝 symlink/junction，重查根/条目/句柄身份，不承诺恶意并发命名空间原子隔离 |
| Windows HTTP 原生服务（已实现 sender/receiver） | WindowsHttpService 显式 start/stop、地址/错误查询与清理重试；通用注册表负责两角色状态/取消/期限；receiver 完整校验后顺序发布，保留逐项结果 | 注入 publisher 及 archive.receive 才支持接收；能力不授予根写权限；构造及应用启动不监听网络，默认回环；UI/服务控制 IPC 留 WP-007；应用退出等待 HTTP 与发布模块停止；无文件字节跨桥 |
| Windows 原生新文件发布（已实现） | WindowsNewFilePublisher 的 grant/revoke、checkTarget、publish、retryCleanup/stop；单文件结果与清理分开；只在本机显式授权的专用测试根写入 | 不直接处理 HTTP 或 UI，供 receiver 原生编排；读取登记不授予写权限，授权/候选所有权不跨进程保存；同目录 wx 候选经哈希/sync 后排他 link，最终回读才成功；不支持卷失败，未核实发布返回 unknown；输入关闭后返回，无安全覆盖/删除或自动恢复 |
| Windows 私有归档（已实现） | createWindowsArchiveAdapter、prepare/receive（onArchiveStored 为压缩体检查点，不表示完整归档通过）、不可变清单、openArchive/openFile/dispose/retryCleanup；source 仍只读；目录流提供 verifyUnchanged 与缓存隔离检查 | 不返回可供 Renderer 使用的路径/句柄；完整 gzip/原文校验后返回私有缓存；无 HTTP/目标发布；调用者关闭流并 dispose，异常用 operationError，清理失败另报 cleanupError |
| Capacitor Java SAF 插件（已实现，API 33/35 读取验证通过） | chooseDirectory/listRoots/listDirectory；READ 持久授权、当前层元数据和本地 ID | URI/documentId 留在原生层，不接收任意路径；写入能力均不支持；原生只读流由同包调用者消费并关闭，不将内容或 Base64 交给 JS |
| Java 私有归档（已实现） | ArchiveAdapter.prepare/receive、不可变 ArchiveModel、Artifact.openArchive/openFile/close；SafArchiveSource 从本次 SAF 引用原生读取并前后复核；控制器取消关闭读流/查询，资源、期限与清理错误分别检查 | 固定 v1 原生模型，完整校验后才返回句柄；私有真实缓存路径/所有权与进程独占，清理失败保留名额可重试；无 URI/内容跨桥；JSON 解码/网络、目标发布与前台调度分别留对应包；用法见移动说明 |
| Java SAF 新文件发布（已实现） | NewFilePublisher 的 grant/revoke、preflight/publish、cancel/retryCleanup/stop；SafPublicationBackend 仅定位已有根/父目录，PublicationJson 对齐单文件结果和独立清理 | 系统 WRITE 与本次显式授权分开；创建前后核实 ID/父/名，常规 FD 身份及非截断 rw，关闭后 EOF/SHA-256/元数据回读；仅清理身份匹配的新条目，未知不重放，清理失败保留进程名额；无内容/URI 跨桥，原生流可来自已验证归档 |
| Android 后续能力（未实现） | WP-006 原生 HTTP/进度/前台编排 | 复用已验证的归档与新文件发布；真实存档保持只读 |
| 生命周期 | Android 前台允许启动任务；离开前台取消；返回后重新核实当前目录 | 不创建后台服务、不恢复旧任务继续传输；发布竞争按真实结果反馈 |

错误覆盖非法输入、版本不符、权限失效、不存在、不可读、不支持、名称冲突、路径越界、源变化、校验失败、网络失败、存储不足、IO/清理失败和结果待确认。未知属性属于成功读取中的 null；选择取消和任务取消属于独立结果，不伪造为读取错误。

## 5. 版本与线格式

数据声明和映射由共享包提供；Windows HTTP 读取已实现严格 JSON/路由/头/会话和 UTF-8 字节预算，双端私有归档负责实际流、格式、长度与哈希校验。Windows 新文件发布独立验证，HTTP receiver 已完成上传预检/单次 PUT/完整校验与批次编排；Android 单文件发布已实现，网络/批次编排待 WP-006 实现。当前协议使用批量 v1，不提供单文件端点或兼容别名；无 HTTP 消费者阶段原位修订 v1 的例外不作为正式消费者出现后的兼容策略。完整声明见 `packages/shared/README.md`。

- 协议只接受数字版本 1，封闭 DTO 拒绝缺失和额外字段。ID 为 1–128 个 ASCII 字符，首位字母或数字，后续允许字母、数字、下划线和短横线，不接收路径或 URI；批内 fileId 使用受限连续编号。
- 字节数为非负安全整数；时间是 ±8.64e15 范围内的 Unix 毫秒整数，0 和负数有实际含义，未知修改日期用 null。文本非空白且最长 1024 个 UTF-16 码元。
- 新文件名最长 255 个 UTF-16 码元，拒绝路径字符、控制字符、未配对代理项、Windows 保留名和尾部点/空格；不静默改名或归一化。内容哈希固定 64 个小写十六进制字符，只用于当前任务。
- JSON 使用 OperationResult 包络，拒绝重复键/非法 UTF-8。查询 200 不代表任务成功；POST uploads 的 201 仅表示登记，POST downloads 和 PUT content 的 202 均表示处理未完成。GET content 为原始 gzip，流开始后失败由接收校验和状态核实处理。
- 目标 name/parentId 进入 JSON 清单映射；目录读取的可选 parentId 仍为查询参数，省略表示根层。content 的 Content-Length 和 x-archive-sha256 均必填且与 manifest.archive 一致；不设置 Content-Encoding，不自动解压、不跟随重定向、不支持 Range 或自动重放。路由/查询解码一次，拒绝歧义参数/头及非法编码。
- 原错误映射继续复用；新增 session-mismatch/task-conflict=409、invalid-archive=422、resource-limit=413、busy=429、timeout=408。network-failure 是本地错误，映射为 null，不伪造 HTTP 响应；完整定义见批量协议第 7 节。
- canRetry 仅允许核实当前状态后的用户新操作，不授权自动重放；unknown 不承诺远端未写入。取消与发布竞争返回实际观察，不要求远端已完成文件自动回滚。

## 6. 已实现检查与验证边界

packages/shared 保留本地目录/设备/错误/选择结果守卫，新增批量描述、选择/清单/目标请求、归档声明、进度/文件结果/批次状态守卫及 isBatchProgressAdvance。matchesBatchState(value, manifest, direction, receiver?) 对照本次清单和明确方向；receiver 必须提供完整 ReceiveBatchRequest，核对结果覆盖、字节/哈希、目标根/父目录/名称与重复最终条目。sender 不传接收上下文。不依赖 JSON 键顺序，不保存历史。

共享包 32 项运行时测试和 16 项类型反例通过且无平台 IO。Windows 已通过 20 项私有归档专项（含独立 Python 夹具、严格 gzip/USTAR、实际字节预算/取消/所有权与失败清理）；Windows HTTP 的 25 项专项覆盖真实回环/TCP、JSON 精确预算、单次 ID/content、会话/期限/取消、断流/原始错误、清理重试和停止/重启；共享与双端适配回归通过，无新增依赖。Windows 新文件发布的 24 项专项验证授权、候选/link/最终回读、竞争/取消、unknown 与清理重试；Windows receiver 的 29 项真实 HTTP/TCP 专项验证 201/202 两阶段确认、授权/预检/并发/单次 PUT、全部校验前零发布、部分失败/取消/unknown、丢失响应、断流/背压、期限/停止/重启及缓存/候选清理重试；所有查询状态与本次清单/目标上下文核对。完整检查含 114 项桌面测试。Java 归档与实际 SAF 读流已由 TC-032 验证；SAF 单文件发布由 TC-034 的 28 项发布 JVM、2 项 API 33 设备及 12 个共享守卫/外部原文核对结果验证；实际 LAN 网络、总体规模资源与最终界面由后续包验收。

守卫仅校验已解析 JSON/plain data，不执行文件、网络、哈希计算、生命周期控制或脱敏，不改变/克隆/冻结输入；平台负责资源所有权、释放、线程隔离及原生异常到错误码的映射。跨 Java/JS 的超范围整数在原生侧拒绝，未知属性显式输出 null；SAF 日期 0 依提供者约定转换为未知。调用示例及桥生命周期说明见 `packages/shared/README.md`、`apps/mobile/README.md`。

运行时契约测试、只读/联合类型反例、移动桥、严格类型与双端构建均纳入 pnpm check；pnpm android:test 执行 Java 单元、lint、两个 APK 编译及 Windows/JVM 原生双向归档互通。实际 SAF 设备证据见回归状态；Windows sender 的回环 HTTP 已验证，真实 LAN/Android、传输前台中断与完整产品仍待验证，不能将共享守卫通过当作产品验收通过。

Windows 目录与 IPC 的 16 项测试已通过，含真实 8.3 短路径环境的子进程回归；授权真实目录的只读原生流与配置恢复检查中，前后内容哈希与修改时间一致。构建后的 CJS preload 隔离加载仅需 Electron 依赖。系统选择器人工交互及最终目录界面仍待界面包验证；真实目录禁止写入/删除/修改，测试配置与夹具独立存放，不保存真实路径或文件哈希。
