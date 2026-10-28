---
doc_type: api-contracts
status: active
priority: medium
owner: architecture
updated: 2026-10-29
tags: [API, 接口约定]
related_files: []
---

# 接口约定

## 目录

- [1. 状态与范围](#1-状态与范围)
- [2. 共用数据语义](#2-共用数据语义)
- [3. Windows HTTP 接口约定](#3-windows-http-接口约定)
- [4. 本地桥与错误边界](#4-本地桥与错误边界)
- [5. 版本与线格式](#5-版本与线格式)
- [6. 检查与验证边界](#6-检查与验证边界)
- [7. 游戏设备元数据与界面](#7-游戏设备元数据与界面)

## 1. 状态与范围

版本 1 的本地/批量共享模型、双端目录读取、双端私有归档、Windows HTTP sender/receiver 和非覆盖发布已经可用。Android SAF 原生读写、HTTP、任务编排与持续通知保持传输已在目标真机上验证，见 TC-032、TC-034、TC-035。平台说明见 `apps/desktop/README.md`、`apps/mobile/README.md`，共享字段与线格式见 `apps/shared/README.md`；范围与依赖见[工作包](../development/work-packages.md)。

M-001 的文件操作范围是专用测试目录内的新文件往返。游戏与设备配置、三页导航、并列目录视图和双端独立界面已经接入；覆盖、镜像删除、备份、mDNS 和 Windows 发起任务留后续里程碑。Windows 为服务端，Android 原生层为 HTTP 客户端。

用户已在[Q-008](../requirements/open-questions.md)确定双向统一采用 tar.gz。完整设计位于 `docs/plans/m001-tar-gzip-protocol.md`；v1 批量共享数据与双端私有归档编解码可用。Windows 提供 v1 读取、sender 和上传 receiver 端点；双端新文件发布和批次编排可用，新增受保护复制接口见第 3 节。

## 2. 共用数据语义

| 模型 | 当前字段与约束 |
| --- | --- |
| DeviceDescriptor | protocolVersion=1、deviceId、displayName、platform、capabilities；稳定 ID 与地址分离 |
| DirectoryReference | rootId、deviceId、displayName、authorization；授权状态 granted/expired/unavailable/unverified；可选 displayPath 是完整展示路径或提供者地址，parentName 是可取得的父目录名。两个字段只用于展示和默认游戏名，文件操作仍只传不透明引用；守卫同时接受原四字段格式 |
| EntryMetadata | rootId、entryId、parentId、name、kind、sizeBytes、modifiedAt、capabilities；file/directory 联合；根层 parentId=null，parentId 不指向自身；文件夹大小恒为 null，文件未知大小为 null，空文件为 0 |
| DirectoryListing | rootId、parentId、observedAt、entries；成功空数组表示空目录；条目须属于同一根/层且 ID 不重复；错误用独立包络 |
| EntryCapabilities / DeviceCapabilities | 条目能力 canRead/canList/canCreate/canRename/canDelete；设备能力 canListRoots/canReadFiles/canReceiveFiles/canQueryTransfers/canCancelTransfers；各值 supported/unsupported/unknown |
| OperationError / OperationResult | code、message、canRetry；互斥 success/value 与 error/error 包络；result-unknown 的 canRetry 必须为 false；错误消息由生产者脱敏 |
| DirectorySelectionResult | selected 携带 directory，cancelled 不携带目录或错误，error 携带错误；取消不清空既有有效引用 |
| BatchDeviceDescriptor | 共享模型：包装既有 device，加 sessionId 和固定 limits；本地目录桥返回值不变 |
| BatchManifest / TargetSelection | 提供 DTO 和关系校验：源引用、连续 fileId、实测长度/哈希及精确 tar 求和；目标在已有父目录以单文件名一一映射，不展开归档路径 |
| BatchProgress / BatchState / FileOutcome | 提供角色、阶段、计数和结果聚合校验；sender sent 与 receiver succeeded 分开；逐项成功/失败/取消/未尝试/未知与清理状态分开 |

M-001 支持提供者不保留源修改时间的情况；写入后查询并展示目标实际元数据。内容校验使用哈希，路径、大小和日期只协助判断。

## 3. Windows HTTP 接口约定

M-002 的 `apps/shared/src/sync` 已提供独立 schema 1 的当前扫描、复制/本机恢复计划、备份清单/设置和逐项结果。`createSyncPlan` 只处理本次快照；`isSyncPlan` 重新推导动作与计数，执行方以 `matchesSyncPlan` 对照持有的当前输入，以 `matchesSyncApplyResult` 核对完整结果和实际指纹。规则统一见仓库根目录的 `docs/plans/m002-sync-copy.md` 第 3 节。

Windows 新增 `/v1/sync/capabilities`、`POST /v1/sync/scans` 和 `GET/DELETE /v1/sync/scans/{scanId}`，沿用会话头/严格 JSON；登记仅接收 schemaVersion/rootId，202 后查询 SyncScanState。有限 desktopService 桥增加 startScan/queryScan/cancelScan，校验本机来源、参数和返回引用。扫描只读，完整指纹/空目录/失败部分结果分开；取消关流、结果到期、停止及重启会话均已接入。

Android → Windows 新复制协议已接入。Windows 提供只读项目设置、任务登记、单次清单/内容上传、查询/取消及归档校验后备份和写入，启用原生依赖后声明 canCopy/canBackup。任务固定当前会话扫描、双向项目关联、设备/根及目标备份设置；实际同步通信可更新既有设备在线时间。全任务借用同一进程名额到缓存及候选清理，回执丢失不重放，零文件分支没有归档。共享任务/准备 DTO 和守卫已提供；Android 的 SyncTransfers 有限桥分开普通扫描准备、同次确认、状态/清单及取消/释放，只有确认执行启动传输通知。sender sent 与实际 receiver 结果分开，页面重建可重新取得原生预览核对结果。实际 SAF/LAN、回执丢失、关闭备份、目标变化及取消已验证；Windows → Android 和界面继续后续工作包。本机恢复经本地桥提供，远端恢复入口保持关闭。完整字段与期限统一见 `docs/plans/m002-sync-copy.md` 第 3.6/3.7 节。

共享包导出以下 v1 路由常量和 DTO。Windows 读取/sender、uploads/PUT receiver 及通用查询/取消端点现已可用；完整字段、状态码和例外以仓库根目录的 `docs/plans/m001-tar-gzip-protocol.md` 为准。WP-012/WP-013 分别负责双端归档，网络包只编排这些能力。

| API | 方法 | 请求 | 响应 | 错误边界 | 工作包 |
| --- | --- | --- | --- | --- | --- |
| /v1/device | GET | 无 | BatchDeviceDescriptor：device、sessionId、limits | 版本不兼容时客户端停止文件操作 | WP-004 |
| /v1/roots | GET | 无 | 本机用户已经选择用于本次验证的根目录描述 | 只枚举本机已选择的根目录 | WP-004 |
| /v1/roots/{rootId}/entries | GET | 可选 parentId；省略表示根层 | 当前层条目及读取时间 | 非法引用、目录失效、不可读与空目录分别表达 | WP-004 |
| /v1/transfers/downloads | POST | DownloadBatchRequest | 202，已接纳的 sender 状态 | 202 表示任务已接纳；ready 和文件结果另行查询 | WP-004 |
| /v1/transfers/{transferId}/manifest | GET | 已准备的任务引用 | 200，本次 BatchManifest | 未准备好冲突，不读取另一会话清单 | WP-004 |
| /v1/transfers/{transferId}/content | GET | sender ready 任务引用 | 200，application/gzip 原始体 | 单次领取；发送失败与手机实际发布结果分开 | WP-004 |
| /v1/transfers/uploads | POST | ReceiveBatchRequest：清单、目标根和逐项目标映射 | 201，已登记的 receiver 状态 | 201 表示任务已登记；文件发布另行查询，同名目标会拒绝 | WP-005 |
| /v1/transfers/{transferId}/content | PUT | 已登记清单对应的唯一 gzip 原始体 | 202，压缩体收齐且长度/SHA-256 匹配的 verifying 快照，异步解包校验/发布 | 全部校验前无目标写入；断流/取消/部分发布如实反馈 | WP-005 |
| /v1/transfers/{transferId} | GET | 本次会话任务 ID | 200，运行阶段或实际结果 | 不存在或到期时重读当前目标；任务可能已经写入 | WP-004 通用注册表；WP-005 接收任务 |
| /v1/transfers/{transferId} | DELETE | 取消本次任务 | 活动 202 / 终态 200，实际状态 | 与发布竞争时返回实际结果；已经发布的最终文件保留 | WP-004 通用取消；WP-005 接收取消 |

路由参数、任务清单和归档条目都必须验证。parentId 是目录引用，name 为单个合法文件名；归档成员必须与本次清单一致，绝对路径、路径穿越、重复成员及链接越界会被拒绝。写盘使用清单映射，不使用归档路径。Windows 解析引用时还要校验真实根目录边界，拒绝符号链接/junction 越界，也不接收主机绝对路径。共享守卫只检查数据；平台权限、实际路径与名称竞争由各平台检查。

双向使用 gzip level 1 + 受限 USTAR，成员名仅为连续 fileId。固定预算为每批最多 1024 文件、单文件 256 MiB、原文合计 1 GiB、压缩体 1088 MiB、解压 tar 1 GiB+1 MiB、JSON 8 MiB、私有暂存 3 GiB；每端一个活动批次，显式 IO 缓冲不超过 64 KiB。未知源长度先私有暂存实测；接收端完整验证压缩体、tar 结束及全部逐文件内容后才发布。每次接收在内容流开始前检查缓存和可取得的目标余量；Windows 同卷合计缓存/目标峰值，SAF 容量未知时保留未知，空间不足返回 insufficient-space，实际写入继续检查。发布按文件进行；首次失败后停止后续，保留成功项并列出残留。SAF 无法保证不改写既有条目时，流程会停止或报告待确认；createDocument 只创建条目，排他性由提供者检查确认。

transferId 只属于当前会话，不是历史同步基线。服务以每次启动的 sessionId 隔离任务，除设备描述外要求 x-sync-session-id；同会话 ID 不复用，content 只领取一次。ready 等待 10 分钟，接收等体 2 分钟，总期限 30 分钟，网络无进展 60 秒终止；终态保留 10 分钟，随后清除清单/哈希/结果，并保留最多 4096 个已用 ID。服务重启或响应丢失时，远端可能已经写入；重新读取目标确认，不自动重放旧任务。

## 4. 本地桥与错误边界

| 边界 | 可传递的内容 | 限制 |
| --- | --- | --- |
| Electron preload | chooseDirectory、listRoots、listDirectory；只接受 ID，返回公开 DTO；系统选择器在主进程执行 | 无 fs/shell/Node、绝对路径、内容或写入接口；校验登记窗口、主 frame 与精确 URL；退出移除 handler |
| Electron 服务桥 | desktopService 的 status/start/randomizePort/stop/chooseTarget/revokeTarget/cancel/retryCleanup；状态含 configuredPort、实际端口/IPv4 地址、错误、已授权接收根和会话任务 | 窗口/主 frame/精确 URL 与参数/DTO 校验；start 端口为 1..65535，显式监听 0.0.0.0；首次生成并保存 49152..65535 随机端口，后续读取既有值；randomizePort 排除当前值并保存，运行时拒绝修改；选择目录后 grant；卸载停止轮询，退出移除 handler |
| Electron 主进程原生读取 | registerDirectory 登记系统选中路径，listDirectory 返回当前层，openFile 返回本进程只读流 | 配置独立存放，没有历史清单；调用者消费或 destroy 流；逐段拒绝 symlink/junction，重查根/条目/句柄身份；恶意并发命名空间不在原子隔离范围内 |
| Windows 独立备份与本机桥 | createWindowsBackupStore 的 create/list/settings/setPreference/capacity/acquire/rotate/cleanupIncomplete/stop；desktopBackups 提供只读摘要/单轮清单、设置及显式清理，创建与原生恢复流不跨桥 | userData/backups 与同步根隔离；内容校验、落盘和回读后提交，最近 3 次及恢复材料引用保护；失败创建不返回有效轮次，轮换错误独立；位置 displayPath 仅供展示，IPC 无文件路径参数或内容；具体参数和资源责任见桌面 README |
| Windows 受保护写入与恢复 | WindowsSyncWriter.apply/prepareRestore/checkSpace/retryCleanup/stop；材料为匹配快照和可重复原生读流，返回 SyncApplyResult；WindowsSyncScanner.wait 供原生等待同次扫描 | 整批目标/原文复核、峰值容量及完整备份后创建目录/逐文件发布/回读；旧批次与新任务共用互斥，候选清理失败保留名额，恢复强制备份且引用输入；原生 authorize 核对项目/根，Android 上传 HTTP 借用全任务名额并反复核实上下文，本机界面继续后续工作包，接口及资源责任见桌面 README 第 13 节 |
| Windows HTTP 原生服务（sender/receiver） | WindowsHttpService 显式 start/stop、地址/错误查询与清理重试；通用注册表负责两角色状态/取消/期限；receiver 完整校验后顺序发布，保留逐项结果 | 注入 publisher 及 archive.receive 才支持接收；能力不授予根写权限；构造及应用启动不监听网络，默认回环；WP-007 用受限 IPC 提供服务控制与任务快照，getStates 不延长期限；应用退出等待 HTTP 与发布模块停止；无文件字节跨桥 |
| Windows 原生新文件发布 | WindowsNewFilePublisher 的 grant/revoke、checkTarget、publish、retryCleanup/stop；单文件结果与清理分开；只在本机显式授权的专用测试根写入 | HTTP 和 UI 由 receiver 编排；读取登记不会授予写权限，授权/候选所有权只在当前进程内有效；同目录 wx 候选经哈希/sync 后排他 link，最终回读才成功；无法硬链接的卷会失败，未核实发布返回 unknown；输入关闭后返回，没有覆盖、删除或自动恢复 |
| Windows 私有归档 | createWindowsArchiveAdapter、prepare/receive、不可变清单、openArchive/openFile/dispose/retryCleanup；onArchiveStored 只确认压缩体检查点；source 仍只读；目录流提供 verifyUnchanged 与缓存隔离检查 | 不返回可供 Renderer 使用的路径/句柄；完整 gzip/原文校验后返回私有缓存；HTTP 和目标发布交给上层；调用者关闭流并 dispose，异常用 operationError，清理失败另报 cleanupError |
| Capacitor Java SAF 插件（API 33/35 读取验证通过） | chooseDirectory/listRoots/listDirectory；READ 持久授权、当前层元数据和本地 ID | URI/documentId 留在原生层，不接收任意路径；写入能力均不支持；原生只读流由同包调用者消费并关闭，不将内容或 Base64 交给 JS |
| Android 当前扫描 | SyncScansPlugin 的 capabilities/start/query/cancel；start 接收 schemaVersion=1/rootId，query/cancel 接收 scanId，返回 OperationResult 包络及共享 SyncScanState | 本次递归 SAF 读取及原生 SHA-256；未知长度按流实测，源变化/权限/预算/取消分别报告；结果限时存内存，不加保活或前后台处理；调用见移动 README |
| Android 独立备份 | BackupStore/Model/Files、AndroidBackupIo 提供私有备份创建、校验、三轮保留、设置/容量及恢复材料引用；SyncBackupsPlugin 提供 read/list/manifest/setPreference/rotate/cleanupIncomplete | 创建只由原生确认计划编排调用；SAF 读取后校验，私有 files/backups 落盘/回读/提交，普通查询仅公开 ID/摘要/清单，displayPath 仅供展示；不跨桥传内容/句柄，不新增备份目录选择；错误与资源责任见移动 README |
| Android 受保护写入与本机恢复 | SyncPlanModel 重算可执行计划，SyncWriter.apply 与 SafSyncBackend 执行原生目标写入；SyncWrites/TS bridge 提供 bindProject/prepareRestore/preview/execute/query/cancel/release/retryCleanup | 平台从保存配置绑定项目/根，原生检查持久写权限和固定预览；完整输入/目标复核、容量和有效备份后创建/覆盖/回读，rw 不预截断；本机恢复强制保护当前内容，输入引用/取消/清理与实际结果分开；仅公开 DTO/ID，不公开 URI/路径/流，HTTP 与页面待后续接入；详见移动 README |
| Java 私有归档 | ArchiveAdapter.prepare/receive、不可变 ArchiveModel、Artifact.openArchive/openFile/close；SafArchiveSource 从本次 SAF 引用原生读取并前后复核；控制器取消关闭读流/查询，资源、期限与清理错误分别检查 | 固定 v1 原生模型，完整校验后才返回句柄；私有真实缓存路径/所有权与进程独占，清理失败保留名额可重试；无 URI/内容跨桥；JSON 解码/网络、目标发布与前台调度分别留对应包；用法见移动说明 |
| Java SAF 新文件发布 | NewFilePublisher 的 grant/revoke、preflight/publish、cancel/retryCleanup/stop；SafPublicationBackend 仅定位已有根/父目录，PublicationJson 对齐单文件结果和独立清理 | 系统 WRITE 与本次显式授权分开；创建前后核实 ID/父/名，常规 FD 身份及非截断 rw，关闭后 EOF/SHA-256/元数据回读；仅清理身份匹配的新条目，未知不重放，清理失败保留进程名额；无内容/URI 跨桥，原生流可来自已验证归档 |
| Android 原生 HTTP/任务 | HttpTransfersPlugin、TransferJson/Schema/Http/Engine、TS 桥；connect、远端当前层、双向 start、query/queryRemote/getManifest/current、cancel/retryCleanup/订阅 | 严格 JSON/头/预算、会话及本次上下文；连接和默认网络无进展等待 5 秒，初次握手总期限 5 秒；单次 ID/内容，回执丢失只查询；完整验证后逐项 SAF 发布；sender sent 与 receiver 成功分开，URI/字节不跨桥；用法见移动 README |
| 清单前终态 | Android 下载在清单生成前取消/失败，生成逐文件 not-attempted 的接收终态 | TS 桥仅在本地下载终态、缺少清单、文件 ID/顺序/数量和原因均匹配时接纳；任何已写入结果继续要求完整清单/目标校验 |
| 生命周期 | 业务不判断前后台；普通目录、扫描、连接和查询不处理切后台后的成败。仅传输由 TransferRuntime 应用级持有，使用 dataSync 前台服务与持续通知，Activity 销毁后原传输继续 | 通知权限经用户允许；完成/显式取消和清理后退出；没有自动调度或旧任务重放，current 只重新取得原传输上下文 |

错误覆盖非法输入、版本不符、权限失效、不存在、不可读、不支持、名称冲突、路径越界、源变化、校验失败、网络失败、存储不足、IO/清理失败和结果待确认。未知属性是成功读取中的 null；选择取消和任务取消是独立结果，与读取错误分开。

## 5. 版本与线格式

数据声明和映射由共享包提供；Windows HTTP 读取使用严格 JSON/路由/头/会话和 UTF-8 字节预算，双端私有归档负责实际流、格式、长度与哈希校验。Windows 新文件发布独立验证，HTTP receiver 完成上传预检、单次 PUT、完整校验与批次编排；Android 单文件发布和 WP-006 网络/批次编排已经可用。当前协议使用批量 v1，只有批量端点，没有单文件别名。v1 是在尚无 HTTP 消费者的阶段修订的；现在开始按正式兼容要求维护。完整声明见 `apps/shared/README.md`。

- 协议只接受数字版本 1，封闭 DTO 拒绝缺失和额外字段。ID 为 1–128 个 ASCII 字符，首位字母或数字，后续允许字母、数字、下划线和短横线，不接收路径或 URI；批内 fileId 使用受限连续编号。
- 字节数为非负安全整数；时间是 ±8.64e15 范围内的 Unix 毫秒整数，0 和负数有实际含义，未知修改日期用 null。文本非空白且最长 1024 个 UTF-16 码元。
- 新文件名最长 255 个 UTF-16 码元，路径字符、控制字符、未配对代理项、Windows 保留名和尾部点/空格会被拒绝；改名和归一化不会发生。内容哈希固定 64 个小写十六进制字符，只用于当前任务。
- JSON 使用 OperationResult 包络，重复键和非法 UTF-8 会被拒绝。查询 200 表示请求成功，任务是否成功要看 BatchState；POST uploads 的 201 表示任务已登记，POST downloads 和 PUT content 的 202 表示处理仍在进行。GET content 为原始 gzip，流开始后的失败通过接收校验和任务状态核实。
- 目标 name/parentId 进入 JSON 清单映射；目录读取的可选 parentId 仍为查询参数，省略表示根层。content 的 Content-Length 和 x-archive-sha256 均必填且与 manifest.archive 一致；接口不设置 Content-Encoding，提供单次完整传输，Range、续传和自动重放没有对应入口。路由/查询解码一次，歧义参数/头及非法编码会被拒绝。
- 原错误映射继续复用；新增 session-mismatch/task-conflict=409、invalid-archive=422、resource-limit=413、busy=429、timeout=408。network-failure 是本地错误，HTTP 状态为 null；完整定义见批量协议第 7 节。
- canRetry 用于核实当前状态后的用户新操作，自动重放不在范围内；unknown 表示远端状态待核实。取消与发布竞争时返回实际观察，已经发布的文件会保留。

## 6. 检查与验证边界

apps/shared 保留本地目录/设备/错误/选择结果守卫，并提供批量描述、选择/清单/目标请求、归档声明、进度/文件结果/批次状态守卫及 isBatchProgressAdvance。matchesBatchState(value, manifest, direction, receiver?) 对照本次清单和明确方向；receiver 必须提供完整 ReceiveBatchRequest，核对结果覆盖、字节/哈希、目标根/父目录/名称与重复最终条目。sender 只传 manifest 和方向。清单比较按内容，不按 JSON 键顺序，也没有历史存储。

长期自动化测试只保留共享数据关系、目录/IPC、归档、HTTP、原生发布和桥接边界。桌面与移动测试使用独立合成夹具，验证公开输入输出、文件安全、非覆盖发布、取消、结果未知和清理重试；不测试按钮、文案、DOM、颜色或内部调用顺序。Java 设备测试保留 SAF 只读读取、固定归档互通和实际 SAF 快照三条路径。实际 API 33 LAN 双向、SAF 发布、通知保持和 Activity 重连已通过手工操作、状态核对与截图验证；其它平台、总体规模资源和最终界面由总体验收覆盖。

守卫校验已解析 JSON/plain data，处理范围是数据结构和关系；文件、网络、哈希计算、生命周期控制、脱敏由平台负责。守卫不改变、克隆或冻结输入；资源所有权、释放、线程隔离及原生异常到错误码的映射也在平台层。跨 Java/JS 的超范围整数在原生侧拒绝，未知属性显式输出 null；SAF 日期 0 依提供者约定转换为未知。调用示例及桥生命周期说明见 `apps/shared/README.md`、`apps/mobile/README.md`。

`pnpm check` 只执行文本、格式、lint、严格类型和双端构建。`pnpm test:all` 运行完整自动化测试与 Android 原生测试，日常检查不运行它。默认不新增或扩写自动化测试；功能验证优先编译、实际运行、ADB 操作和截图。

Windows 目录与 IPC 回归包含真实 8.3 短路径环境；授权真实目录的只读原生流与配置恢复检查中，前后内容哈希与修改时间一致。系统选择器人工交互及最终目录界面等界面包验证；真实目录保持只读，测试配置与夹具独立存放，不保存真实路径或文件哈希。

## 7. 游戏设备元数据与界面

传输发起的 `TransferRequest` 现需本机 `projectId`。共享 `resolveSyncProjectBinding` 固定本机/远端项目、设备与目录 ID；Android 在通知授权后重新交换目录表并复核，变化时要求重新预览。双端保存游戏只接受已登记本机目录，活动传输中阻止修改游戏目录/关联。既有 HTTP v1 和 LibraryConfig v1 字段保持。

`apps/shared/src/library/library.ts` 定义本机 `LibraryConfig`、公开 `CatalogGame`、游戏关联及目录查询/应答。一个游戏在每台设备对应一个目录，关联多个稳定设备 ID；首期同时连接一个对端，开始后的传输固定原连接。配置不保存文件清单、哈希或平台路径。

Windows 的 `DesktopLibrary` 在应用私有目录原子保存游戏/设备配置，通过有限 `desktopLibrary` IPC 提供读取、保存游戏、设备管理和手机当前层查询。新建 `POST /v1/catalog` 使用既有会话头、严格 JSON 边界与独立 DTO 校验；手机提交自己的游戏目录表和明确的游戏关联，取回电脑目录表及至多一个当前层查询。目录应答要求请求 ID、根 ID 和父 ID 全部匹配；父目录必须来自已读条目。查询 8 秒超时，15 秒无元数据更新标为离线。手机原生 `exchangeCatalog` 绑定已连接电脑，原生填写本机设备 ID，不接受任意 URL。

现有约 1.8 秒的元数据轮询兼作心跳，不另建 WS。Android 以本次交换成功判断在线，交换失败后空闲连接释放，活动传输仍保留原任务查询上下文。两端从已连接变为未连接时，通过 antd `message` 提示一次“连接已断开”；持续离线不重复提示，也不增加持久错误条或诊断断开原因。手机主动连接失败也使用同一 `message`，颜色和圆角随本端明暗主题同步。

Android 桥提供 `connections`、`selectDevice`、`disconnectDevice`、`exchangeCatalog`；原生和界面均限制单连接。Activity 重建查询原生连接和当前任务，文件通道、持续通知和任务结果语义沿用 WP-006。对端主动关联只合并公开元数据，目录写权限来自本机系统选择器；本机解除关联后记录排除项，避免下一次元数据交换自动加回。

新增设备的默认名称使用对端声明：Windows `/v1/device` 默认返回系统计算机名称，Android catalog 优先读取系统设备名称，读取失败或空值时使用型号，名称限 128 个 UTF-16 码元且截断不拆开代理对。两端已有保存的名称继续保留，重新连接或元数据轮询不覆盖自定义名；协议与配置格式保持原版本。

添加或导入游戏时先选择本机目录，选定后才能确认并写入游戏配置；取消不添加游戏。目录设置显示 `displayPath`，游戏名默认取 `parentName`，缺省时用 `displayName`。选择目录即为写入授权，两端不再提供单独的“允许接收”和“撤销接收授权”入口。Android 使用系统选择器保存持久 READ/WRITE 权限，每次下载前由 TransferRuntime 重新核实并恢复 publisher 授权；Windows 根据已保存的本机游戏目录，在上传接收前检查 rootId、目录身份与写权限。进程重启后继续使用已配置目录，权限失效时重新选择；只恢复目录写入授权，不恢复旧传输任务。

主动握手后的首个 catalog 请求携带 `x-sync-connect: 1`，普通轮询不携带。桌面断开只修改进程内会话和待处理目录请求，不写入 `blocked=true`；断开后的普通轮询收到 `session-mismatch`，手机再次主动连接时清除标记。连接失败返回 HTTP 状态、协议码及原生 errno 或异常类型，不附加原因改写或重试建议。

界面由 `apps/desktop/src/renderer/src` 和 `apps/mobile/src` 各自维护，平台接入位于各端 `platform/library-adapter.ts`。`apps/shared` 提供协议、配置、任务数据、传输预检与游戏关联规则，不依赖组件库或平台 API。覆盖、镜像删除和备份恢复留后续业务；当前文件传输保持仅新建语义。
