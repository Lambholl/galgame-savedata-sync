---
doc_type: api-contracts
status: active
updated: 2026-11-14
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
- [8. 发现与连接二维码](#8-发现与连接二维码)

## 1. 状态与范围

本文记录当前接口。Windows 为 HTTP 服务端，Android 原生层为拨号方和控制客户端。平台说明见 `apps/desktop/README.md`、`apps/mobile/README.md`，共享字段与线格式见 `apps/shared/README.md`。

已接入：游戏与设备配置、三页导航、并列目录视图、受保护覆盖、可选的目标多余条目删除、写入前全量备份、本机恢复和两端发起。发现与连接二维码的格式在 `apps/shared` 定义（第 8 节）：电脑端广播并显示二维码，Android 端搜索和扫码；改址自动重连的安排见[路线图](../project/roadmap.md)。

文件传输双向统一采用 tar.gz（[Q-008](../requirements/open-questions.md)），完整设计见 `docs/plans/m001-tar-gzip-protocol.md`。Windows 提供 v1 读取、sender 和上传 receiver 端点；受保护复制接口见第 3 节。

## 2. 共用数据语义

| 模型 | 当前字段与约束 |
| --- | --- |
| DeviceDescriptor | protocolVersion=1、deviceId、displayName、platform、capabilities；稳定 ID 与地址分离 |
| DirectoryReference | rootId、deviceId、displayName、authorization；授权状态 granted/expired/unavailable/unverified；可选 displayPath 是完整展示路径或提供者地址，parentName 是可取得的父目录名。两个字段只用于展示和默认游戏名，文件操作只传不透明引用；守卫也接受不含这两个字段的格式 |
| EntryMetadata | rootId、entryId、parentId、name、kind、sizeBytes、modifiedAt、capabilities；file/directory 联合；根层 parentId=null，parentId 不指向自身；文件夹大小恒为 null，文件未知大小为 null，空文件为 0 |
| DirectoryListing | rootId、parentId、observedAt、entries；成功空数组表示空目录；条目须属于同一根/层且 ID 不重复；错误用独立包络 |
| EntryCapabilities / DeviceCapabilities | 条目能力 canRead/canList/canCreate/canRename/canDelete；设备能力 canListRoots/canReadFiles/canReceiveFiles/canQueryTransfers/canCancelTransfers；各值 supported/unsupported/unknown |
| OperationError / OperationResult | code、message、canRetry，以及确定是哪一端访问文件或目录失败时才有的 device（phone 表示移动端、pc，移动端准备阶段产生并经 sync.report 转给电脑，HTTP 错误不带）；Android 任务状态的 error 也带 device：本机文件访问和授权失效是 phone，转抄电脑报来的文件错误是 pc，取消和超时不带；其余任务错误由 locateSyncError 按方向和中断阶段标出一端，打包阶段的授权失效不按阶段推断；互斥 success/value 与 error/error 包络；result-unknown 的 canRetry 必须为 false；自有错误原文默认英文并由生产者脱敏。界面按 code 翻译，message 与 code 在电脑上悬停可见，任务详情写进技术详情；unwrap 抛带 code 的 OperationFailure，toShownError 转为 ShownError，缺少 code 时保留原文 |
| DirectorySelectionResult | selected 携带 directory，cancelled 不携带目录或错误，error 携带错误；取消不清空既有有效引用 |
| BatchDeviceDescriptor | 共享模型：包装 device，加 sessionId 和固定 limits；本地目录桥的返回值不含这些字段 |
| BatchManifest / TargetSelection | 提供 DTO 和关系校验：源引用、连续 fileId、实测长度/哈希及精确 tar 求和；目标在已有父目录以单文件名一一映射，不展开归档路径 |
| BatchProgress / BatchState / FileOutcome | 提供角色、阶段、计数和结果聚合校验；sender sent 与 receiver succeeded 分开；逐项成功/失败/取消/未尝试/未知与清理状态分开 |

提供者可能不保留源修改时间，写入后查询并展示目标实际元数据。内容校验使用哈希，路径、大小和日期只协助判断。

## 3. Windows HTTP 接口约定

`apps/shared/src/sync` 提供独立 schema 1 的当前扫描、复制/本机恢复计划、备份清单/设置和逐项结果。`createSyncPlan` 只处理本次快照；`isSyncPlan` 重新推导动作与计数，执行方以 `matchesSyncPlan` 对照持有的当前输入，以 `matchesSyncApplyResult` 核对完整结果和实际指纹。规则统一见仓库根目录的 `docs/plans/m002-sync-copy.md` 第 3 节。

Windows 提供 `/v1/sync/capabilities`、`POST /v1/sync/scans` 和 `GET/DELETE /v1/sync/scans/{scanId}`，使用会话头和严格 JSON；登记仅接收 schemaVersion/rootId，202 后查询 SyncScanState。有限 desktopService 桥提供 startScan/queryScan/cancelScan，校验本机来源、参数和返回引用。扫描只读，完整指纹、空目录和失败的部分结果分开；取消时关流，结果会到期，每端最多保留 32 份，满时丢掉最旧的，停止或重启后更换会话。电脑同时只跑一个扫描，移动端发起时遇到 busy 会重试最多 5 秒。电脑写入时把候选文件放在目标文件的同一目录，名称由 shared `writeCandidateName` 生成，形如 `.savedata-copy-<UUID>.tmp`、`.savedata-new-<UUID>.tmp`，UUID 小写。写入途中进程被结束会留下这些候选文件，处理分两步：电脑扫描按 `isWriteCandidateName` 精确匹配后跳过它们，所以它们不进入快照、比较和计划，扫描仍然只读；`WindowsSyncWriter` 开始写目标目录时，先删除目标根目录下所有候选文件，不进入链接指向的目录，删不掉的跳过，下次写入再删。这时持有写入名额，且电脑端有单实例锁，所以目标里的候选文件都是残留。Android 不写候选文件，电脑扫描又跳过残留，不会把它们传给 Android，所以 Android 扫描不做这项处理。

双向复制协议：Windows 提供只读项目设置、任务登记、单次清单/内容上传及源准备/单次内容 GET、查询/取消；Android → Windows 完整校验后由电脑保护并写入，Windows → Android 则由移动端独立完成接收、校验、备份与写入。任务固定当前会话扫描、双向项目关联、设备/根及目标备份设置；实际同步通信更新既有设备在线时间。Windows 源准备异步返回 preparing，扫描资源释放后发布 ready，发送完成只报告 sent。Android 下载前合计缓存/备份/已知同卷增量，原生写入器借用确认时的名额和时间并重新扫描目标；完整 receiver 结果与发送状态分开。全任务保持进程互斥至清理结束，回执丢失只查询，内容不重放，零文件没有归档。SyncTransfers 有限桥分开普通扫描准备、同次确认、状态/清单及取消/释放，只有确认执行启动传输通知；页面重建后可取回原生预览核对结果。本机恢复经本地桥提供，没有远端恢复入口。完整字段与期限统一见 `docs/plans/m002-sync-copy.md` 第 3.6/3.7 节。

设备间控制走 WebSocket `/v1/control`，文件内容走 HTTP 路由。拨号方先完成 `POST /v1/catalog` 交换，再带 `x-sync-session-id` 和 `x-sync-device-id` 升级；监听方核对会话、设备已交换目录表、未停用、未被断开且没有另一台设备在线，不满足返回 403。消息格式对称，双方都能发请求、回应答、推事件：`{v:1, type:request|response|event, id?, method, body|result}`，单条最多 8 MiB，只收文本帧，JSON 严格解析（重复键、非法 UTF-8 关闭 1007，格式不符关闭 1008）。请求方法有 `directory.list`、`sync.prepare`、`sync.confirm`、`sync.cancel`、`sync.job.read`、`sync.job.cancel`，事件有 `catalog.changed`、`sync.report` 和 `sync.job`；请求 8 秒无应答即失败。监听方每 15 秒 ping，一个周期无 pong 就断开。关闭码 4001 表示监听方断开了这台设备，拨号方不再重连；4002 表示同一设备的新连接取代旧连接；其他关闭时拨号方 2 秒后重连。格式和守卫在 `apps/shared/src/control`，电脑 `control-hub.ts`（ws）监听，移动端 `ControlClient.java`（Java-WebSocket）拨号，网页经 `platform/control-channel.ts` 收发。两端须同版，没有轮询回退。目前只有电脑监听、移动端拨号，任意两台设备互传见 REQ-022。

电脑发起复制复用移动端的扫描与执行，经控制通道传递。电脑 `remote-sync-requests.ts` 同时只保留一个请求：发起时发 `sync.prepare {requestId, projectId, direction}`，移动端应答后开始扫描，用 `sync.report` 回报 preparing、ready（附计划）或 failed。移动端有传输刚结束时最多等 2 秒再判断是否 busy；新扫描取代还没结束的旧扫描，等待期间被取消或被更新请求取代的 `sync.prepare` 只应答、不扫描；ready 计划须是对应项目、方向、设备和根的覆盖复制。`sync.report` 附的计划固定 `shouldDeleteExtras=false`，电脑确认后发 `sync.confirm {requestId, shouldDeleteExtras}`，两端用同一批快照各自算出选定的计划；移动端执行并应答 `{jobId}`，jobId 等于 planId 时记为 running；之后的进度和结果来自下面的任务观察。电脑取消发 `sync.cancel`，移动端取消并释放本机扫描；控制连接断开时未确认的请求记为失败，已确认的请求记为结果待确认，移动端重连后由摘要更新。有限 desktopSync 桥提供 remoteRequest/startRemote/remotePlan/confirmRemote/cancelRemote。

任务观察对两种发起方式、两个方向相同。版本：`/v1/sync/capabilities.schemaVersion` 为 4，是唯一的版本门槛，版本不符的对端在创建任务前得到“请更新两端”；控制消息 `v` 为 1。`SyncJobState.schemaVersion` 为 3，含 `failureStage`（失败、取消或待确认时停在哪个阶段，取值为 cleaning、done 以外的阶段；成功、已发送或没有记录时为 null，清理和终态更新不改写它）。`SyncTransferState` 为 1。

进度 `SyncJobProgress` 在批量进度的九个字段之外带 `backupBytesCopied` 和 `totalBackupBytes`。`totalBackupBytes` 等于计划的 `backupFileBytes`（由 shared `syncJobBackupBytes` 算出，计划里为 null 时为 0），两端都按计划核对；`backupBytesCopied` 是接收端备份时已写进备份的字节数，每写一块更新一次，只增不减，发送端始终为 0，接收端成功时等于总量。写完后重读核对备份文件和轮换不计入进度。`observeSyncJob` 用这两个字段算备份段的百分比，总量为 0 时百分比未知。Android 通知在备份阶段按同样的字段显示百分比。

| 消息 | 方向 | 内容 | 失败含义 |
| --- | --- | --- | --- |
| 事件 `sync.job` | 移动端原生 → 电脑 | `SyncJobDigest`：`SyncJobState` 去掉逐项 result。有变化时发，进行中每秒至少一次，检查周期 500ms；只在发送成功后记为已发，断开期间的变化重连后补发 | 未知任务或别的设备的摘要被忽略；角色、方向、总量与计划不符时记 result-unknown |
| 请求 `sync.job.read {jobId}` | 电脑 → 移动端原生 | 完整 `SyncJobState`。只在接收端结束后读一次，取得逐项结果 | 任务不存在或属于别的设备返回 not-found；失败时每 5 秒重试，其间显示结果待确认 |
| 请求 `sync.job.cancel {jobId}` | 电脑 → 移动端原生 | null。移动端记录为用户取消，而不是网络失败；已结束的任务不受影响 | 移动端还没建立任务时返回 not-found，电脑报告操作失败 |

这三项由 `SyncTransferEngine` 处理，不经页面，页面被回收或任务由移动端发起时同样工作。角色状态互相独立，成功只看接收端的读回结果：`observeSyncJob(local, remote, hasRemoteError)` 合成阶段、当前段百分比、失败阶段和计数，发送端结束而接收端未结束时仍是进行中。结束后的结论依次判断：接收端成功为 done；接收端待确认为 unknown，有成功项也一样，没确认的条目可能已写入；其余有成功项为 partial。界面的部分完成说明只列不为 0 的成功、失败、待确认、未执行，取消和未尝试的条目算未执行；完成说明把文件、新建文件夹和删除分开计数。清理失败时，任务条在传输成功时只写清理失败，其他结论后面接着写清理失败。对端状态不可信（控制通道断开、60 秒没有摘要、结果读取失败）时 `remoteError` 为 result-unknown，本机也结束后显示待确认，新的摘要或结果会清除它。电脑作为接收端还没收到内容时，移动端摘要报失败或取消就取消电脑这一端；在准备阶段 60 秒没有摘要，按超时结束。

电脑侧 `copyState`、`cancelCopy` 返回 `SyncTransferState`，`DesktopCopySummary` 用 phase、stage、step、percent 表示进度，由主进程计算，详情、游戏进度条、历史和完成提示读同一份，高频更新不携带逐项结果。已确认但移动端还没登记任务时，`remote-sync-requests.ts` 用同一个 jobId 提供占位的摘要、计划和状态，摘要的 `isAwaitingPeer` 为 true，详情和任务条写“等待对方设备开始”；登记后改由 `WindowsSyncRegistry` 提供。对端未结束的任务不会被留存清理，也算作有运行中的工作。

备份展示字段和计划的 `shouldDeleteExtras`、`delete-file`、`delete-directory` 由 `/v1/sync/capabilities.schemaVersion` 一起覆盖，两端须同版，封闭 DTO 严格校验。计划动作的执行顺序是新建文件夹（由浅到深）、写文件、删除（由深到浅，同深度按路径），两端必须算出相同顺序。恢复计划固定 `shouldDeleteExtras=false`。文件在删除前核对身份和完整内容；文件夹只删空的，Windows 用非递归 `rmdir`，Android 的 `deleteDocument` 会递归，所以先确认文件夹为空。系统已开始删除但结果没能确认时报 result-unknown。

| 字段 | 位置 | 含义 | 失败或未知 |
| --- | --- | --- | --- |
| `backupKeepCount`（1–10） | `GET /v1/sync/projects/{id}` 的 `SyncProjectDescriptor`、`SyncPreparationPreview`、`sync.report` 的 ready | 被写入端这个游戏实际生效的保留份数。移动端发送时取电脑项目描述，电脑发送时取移动端设置；电脑发起时由移动端随 ready 回报 | 必填，越界即校验失败；电脑请求在 ready 之前为 null，计划不显示份数 |
| `backupFileCount` | `SyncApplyResult` | 本次已提交备份清单里的文件数，来自实际清单，不用计划数估算 | 没有备份时 null；有 backupId 而为 null 时只说“已备份” |
| `incomplete: {backupId, occupiedBytes}[]` | 双端备份列表（Windows 与 Android 桥） | 未提交轮次及其占用字节数，还包括文件被用户删除或大小不符的备份 | 读不到为 null，界面显示大小未知，与 0 字节分开 |

备份按游戏归组：本机备份桥的列出、读清单、单独设置、轮换、清理和删除都只按 `projectId`（加 `backupId`）查找，不带 rootId。游戏换了目录后，旧目录的备份照常列出、参与轮换，恢复写进游戏当前的目录；备份清单里的 rootId 只记录备份时的目录。备份设置 `SyncBackupSettings.schemaVersion` 为 3，每个游戏最多一条单独设置 `{projectId, shouldBackup, keepCount}`；读到 v2 时按游戏合并，同一游戏有多条时保留最后一条，下次保存写成 v3。这是本机文件格式，不影响能力版本。

删除备份只走本机受限桥，不经网络：电脑 `desktopBackups.deleteBackup(projectId, backupId)`，移动端 `SyncBackups.deleteBackup` 同参数。已不存在的算删除成功，因为用户可能已在文件管理器里删掉；被恢复引用或有传输、恢复运行时返回 busy；中途失败时轮次变成未完成残留，可用清理入口重试。移除游戏时先调 `deleteGameBackups(projectId)`（两端同名），删掉这个游戏在所有目录下的轮次、残留和单独设置，成功后才保存游戏配置；失败时游戏保留，可以重试。存档文件不动。

按游戏查询：移动端 `SyncTransfers.latest({projectId})` 只查进程内任务登记表，返回该本机项目最近的 jobId 或 null，之后用 query/preview 读取；留存期和容量与任务登记表相同，进程重启后没有记录。全局活动判断用 `current()`。本机设备名：移动端 `HttpTransfers.deviceName()`，电脑 `DesktopServiceSnapshot.deviceName`，取值规则与发给对端的相同；读取失败为空，界面留空，不用对端保存的名称。

共享包导出以下 v1 路由常量和 DTO，Windows 提供对应端点；完整字段、状态码和例外以仓库根目录的 `docs/plans/m001-tar-gzip-protocol.md` 为准。归档由双端归档模块负责，网络层只负责编排。

| API | 方法 | 请求 | 响应 | 错误边界 |
| --- | --- | --- | --- | --- |
| /v1/device | GET | 无 | BatchDeviceDescriptor：device、sessionId、limits | 版本不兼容时客户端停止文件操作 |
| /v1/roots | GET | 无 | 本机用户已选择的根目录描述 | 只枚举本机已选择的根目录 |
| /v1/roots/{rootId}/entries | GET | 可选 parentId；省略表示根层 | 当前层条目及读取时间 | 非法引用、目录失效、不可读与空目录分别表达 |
| /v1/transfers/downloads | POST | DownloadBatchRequest | 202，已接纳的 sender 状态 | 202 表示任务已接纳；ready 和文件结果另行查询 |
| /v1/transfers/{transferId}/manifest | GET | 已准备的任务引用 | 200，本次 BatchManifest | 未准备好冲突，不读取另一会话清单 |
| /v1/transfers/{transferId}/content | GET | sender ready 任务引用 | 200，application/gzip 原始体 | 单次领取；发送失败与移动端实际发布结果分开 |
| /v1/transfers/uploads | POST | ReceiveBatchRequest：清单、目标根和逐项目标映射 | 201，已登记的 receiver 状态 | 201 表示任务已登记；文件发布另行查询，同名目标会拒绝 |
| /v1/transfers/{transferId}/content | PUT | 已登记清单对应的唯一 gzip 原始体 | 202，压缩体收齐且长度/SHA-256 匹配的 verifying 快照，异步解包校验/发布 | 全部校验前无目标写入；断流/取消/部分发布如实反馈 |
| /v1/transfers/{transferId} | GET | 本次会话任务 ID | 200，运行阶段或实际结果 | 不存在或到期时重读当前目标；任务可能已经写入 |
| /v1/transfers/{transferId} | DELETE | 取消本次任务 | 活动 202 / 终态 200，实际状态 | 与发布竞争时返回实际结果；已经发布的最终文件保留 |

路由参数、任务清单和归档条目都必须验证。parentId 是目录引用，name 为单个合法文件名；归档成员必须与本次清单一致，绝对路径、路径穿越、重复成员及链接越界会被拒绝。写盘使用清单映射，不使用归档路径。Windows 解析引用时还要校验真实根目录边界，拒绝符号链接/junction 越界，也不接收主机绝对路径。共享守卫只检查数据；平台权限、实际路径与名称竞争由各平台检查。

双向使用 gzip level 1 + 受限 USTAR，成员名仅为连续 fileId。固定预算为每批最多 1024 文件、单文件 256 MiB、原文合计 1 GiB、压缩体 1088 MiB、解压 tar 1 GiB+1 MiB、JSON 8 MiB、私有暂存 3 GiB；每端一个活动批次，显式 IO 缓冲不超过 64 KiB。未知源长度先私有暂存实测；接收端完整验证压缩体、tar 结束及全部逐文件内容后才发布。每次接收在内容流开始前检查缓存和可取得的目标余量；Windows 同卷合计缓存/目标峰值，SAF 容量未知时保留未知，空间不足返回 insufficient-space，实际写入继续检查。发布按文件进行；首次失败后停止后续，保留成功项并列出残留。SAF 无法保证不改写既有条目时，流程会停止或报告待确认；createDocument 只创建条目，排他性由提供者检查确认。

transferId 只属于当前会话，不是历史同步基线。服务以每次启动的 sessionId 隔离任务，除设备描述外要求 x-sync-session-id；同会话 ID 不复用，content 只领取一次。ready 等待 10 分钟，接收等体 2 分钟，总期限 30 分钟，网络无进展 60 秒终止；终态保留 10 分钟，随后清除清单/哈希/结果，并保留最多 4096 个已用 ID。服务重启或响应丢失时，远端可能已经写入；重新读取目标确认，不自动重放旧任务。

## 4. 本地桥与错误边界

| 边界 | 可传递的内容 | 限制 |
| --- | --- | --- |
| Android 复制与恢复界面适配器 | createMobileSyncAdapter 从保存配置固定设备/项目/根，提供准备、固定预览、确认执行、当前任务、取消、备份设置和恢复入口；useSyncTasks 只轮询原生所有者 | 通知授权后重查映射，方向或目录变化后重新扫描确认；sender sent 后目标仍运行时继续只读查询同一 ID；页面卸载不取消任务，重建只查询，不重放执行；`interruptedWrites`/`dismissInterruptedWrite` 读取并一次性清除上个进程留下的写入标记；失败、部分、未知与清理结果分开显示，详细参数和示例见移动 README |
| Windows 同步与恢复界面桥 | desktopSync 提供复制摘要/计划/状态/取消/清理，以及本机恢复准备/预览/确认/状态/取消/清理/释放；DesktopRestoreState 含固定项目/目录/输入备份、阶段、isWorking、实际文件进度及结果/独立清理错误 | 固定 sync:* 通道、受信任窗口/主 frame/URL、封闭 ID 参数、同次原生计划和 8 MiB 响应校验；摘要最多 33 份（32 份已登记任务加一份待移动端登记的任务），准备不占目标名额，确认后持有到清理成功；刷新可查询本进程任务，重启只保留配置/备份和写入标记；`interruptedWrites`/`dismissInterruptedWrite` 读取并一次性清除上个进程留下的标记；电脑发起的桥方法见第 3 节，没有远端恢复；接口及错误见桌面 README 第 13、14 节 |
| Electron preload | chooseDirectory、listRoots、listDirectory；只接受 ID，返回公开 DTO；系统选择器在主进程执行 | 无 fs/shell/Node、绝对路径、内容或写入接口；校验登记窗口、主 frame 与精确 URL；退出移除 handler |
| Electron 服务桥 | desktopService 的 status/start/randomizePort/stop/chooseTarget/revokeTarget/cancel/retryCleanup；状态含 deviceId、configuredPort、实际端口与 startedAt（Unix 毫秒）、其他设备可能访问到的本机 IPv4 地址 ipv4Addresses（先取物理网卡且有默认网关的地址，没有时取任意有默认网关的地址，再加 Windows 移动热点 192.168.137.1；排除 198.18.0.0/15；一个都没有时退回全部可用地址；按推荐顺序、去重，最多 8 个）、错误、广播状态、已授权接收根和会话任务；服务启动后地址还在读取时 ipv4Addresses 为 null，查询失败或没有候选时为空数组 | 窗口/主 frame/精确 URL 与参数/DTO 校验；start 端口为 1..65535，显式监听 0.0.0.0；首次生成并保存 49152..65535 随机端口，后续读取既有值；randomizePort 排除当前值并保存，运行时拒绝修改；选择目录后 grant；卸载停止轮询，退出移除 handler |
| Electron 主进程原生读取 | registerDirectory 登记系统选中路径，listDirectory 返回当前层，openFile 返回本进程只读流 | 配置独立存放，没有历史清单；调用者消费或 destroy 流；逐段拒绝 symlink/junction，重查根/条目/句柄身份；恶意并发命名空间不在原子隔离范围内 |
| Windows 独立备份与本机桥 | createWindowsBackupStore 的 create/list/settings/setPreference/capacity/acquire/rotate/cleanupIncomplete/stop；desktopBackups 提供只读摘要/单轮清单、设置、显式清理和 openFolder，创建与原生恢复流不跨桥 | userData/backups 与同步根隔离，结构和移动端相同（`<游戏名>/<UTC 时间>/` 内含 backup.json 和按原路径保存的 files/）；内容校验、落盘和回读后提交，按保留份数轮换（默认 3 份）并保护恢复材料引用的轮次；失败创建不返回有效轮次，轮换错误独立；位置 displayPath 仅供展示，IPC 无文件路径参数或内容，openFolder 打开的路径由主进程决定；具体参数和资源责任见桌面 README |
| Windows 受保护写入与恢复 | WindowsSyncWriter.apply/prepareRestore/checkSpace/retryCleanup/stop；材料为匹配快照和可重复原生读流，返回 SyncApplyResult；WindowsSyncScanner.wait 供原生等待同次扫描 | 整批目标/原文复核、峰值容量及完整备份后创建目录/逐文件发布/回读；旧批次与新任务共用互斥，候选清理失败保留名额，恢复强制备份且引用输入；原生 authorize 核对项目/根，HTTP 和本机恢复编排借用全任务名额并反复核实上下文；接口及资源责任见桌面 README 第 13/14 节 |
| Windows HTTP 原生服务（sender/receiver） | WindowsHttpService 显式 start/stop、地址/错误查询与清理重试；通用注册表负责两角色状态/取消/期限；receiver 完整校验后顺序发布，保留逐项结果 | 注入 publisher 及 archive.receive 才支持接收；能力不授予根写权限；构造及应用启动不监听网络，默认回环；受限 IPC 提供服务控制与任务快照，getStates 不延长期限；应用退出等待 HTTP 与发布模块停止；无文件字节跨桥 |
| Windows 原生新文件发布 | WindowsNewFilePublisher 的 grant/revoke、checkTarget、publish、retryCleanup/stop；单文件结果与清理分开；只在本机显式授权的专用测试根写入 | HTTP 和 UI 由 receiver 编排；读取登记不会授予写权限，授权/候选所有权只在当前进程内有效；同目录 wx 候选经哈希/sync 后排他 link，最终回读才成功；无法硬链接的卷会失败，未核实发布返回 unknown；输入关闭后返回，没有覆盖、删除或自动恢复 |
| Windows 私有归档 | createWindowsArchiveAdapter、prepare/receive、不可变清单、openArchive/openFile/dispose/retryCleanup；onArchiveStored 只确认压缩体检查点；source 仍只读；目录流提供 verifyUnchanged 与缓存隔离检查 | 不返回可供 Renderer 使用的路径/句柄；完整 gzip/原文校验后返回私有缓存；HTTP 和目标发布交给上层；调用者关闭流并 dispose，异常用 operationError，清理失败另报 cleanupError |
| Capacitor Directories 插件 | chooseDirectory/listRoots/listDirectory；系统选择器与 READ 持久授权、当前层元数据和本地 ID；原生读写只经 `DocumentAccess`，有所有文件访问权限且目录属于系统存储提供者时按路径读写，两种实现返回相同的 ID 和属性 | URI/documentId 留在原生层，不接收任意路径；写入能力均不支持；原生只读流由同包调用者消费并关闭，不将内容或 Base64 交给 JS |
| Android 当前扫描 | SyncScansPlugin 的 capabilities/start/query/cancel；start 接收 schemaVersion=1/rootId，query/cancel 接收 scanId，返回 OperationResult 包络及共享 SyncScanState | 本次递归读取及原生 SHA-256；未知长度按流实测，源变化/权限/预算/取消分别报告；结果限时存内存，不加保活或前后台处理；调用见移动 README |
| Android 独立备份 | BackupStore/Model/Files、AndroidBackupIo 提供 `Android/data` 中备份的创建、校验、按份数轮换、设置/容量及恢复材料引用；SyncBackupsPlugin 提供 read/list/manifest/setPreference/rotate/cleanupIncomplete/deleteBackup | 创建只由原生确认计划编排调用；设置及显式维护争用与传输/恢复相同的目标名额，实际任务清理前拒绝变更。SAF 读取后校验，按 `backups/游戏名/UTC 时间/` 落盘/回读/提交，用户可直接删除；设置在内部 backup-settings.json；查询仅公开 ID/摘要/清单，displayPath 仅供展示；不跨桥传内容/句柄，不新增备份目录选择；错误与资源责任见移动 README |
| Android 受保护写入与本机恢复 | SyncPlanModel 重算可执行计划，SyncWriter.apply 与 DirectorySyncBackend 执行原生目标写入；SyncWrites/TS bridge 提供 bindProject/prepareRestore/preview/execute/query/current/cancel/release/retryCleanup | 平台从保存配置绑定项目/根，原生检查持久写权限和固定预览；完整输入/目标复核、容量和有效备份后创建/覆盖/回读，rw 不预截断；本机恢复强制保护当前内容。current 返回活动或最近恢复 ID，页面据此找回预览和结果；清理失败记录继续保留，明确重试后更新清理状态。输入引用/取消/清理与实际结果分开，仅公开 DTO/ID，不公开 URI/路径/流；详见移动 README |
| Java 私有归档 | ArchiveAdapter.prepare/receive、不可变 ArchiveModel、Artifact.openArchive/openFile/close；DirectoryArchiveSource 从本次 SAF 引用原生读取并前后复核；控制器取消关闭读流/查询，资源、期限与清理错误分别检查 | 固定 v1 原生模型，完整校验后才返回句柄；私有真实缓存路径/所有权与进程独占，清理失败保留名额可重试；无 URI/内容跨桥；JSON 解码/网络、目标发布与前台调度由对应模块负责；用法见移动说明 |
| Java SAF 新文件发布 | NewFilePublisher 的 grant/revoke、preflight/publish、cancel/retryCleanup/stop；DirectoryPublicationBackend 仅定位已有根/父目录，PublicationJson 对齐单文件结果和独立清理 | 系统 WRITE 与本次显式授权分开；创建前后核实 ID/父/名，常规 FD 身份及非截断 rw，关闭后 EOF/SHA-256/元数据回读；仅清理身份匹配的新条目，未知不重放，清理失败保留进程名额；无内容/URI 跨桥，原生流可来自已验证归档 |
| Android 原生 HTTP/任务 | HttpTransfersPlugin、TransferJson/Schema/Http/Engine、TS 桥；connect、远端当前层、双向 start、query/queryRemote/getManifest/current、cancel/retryCleanup/订阅 | 严格 JSON/头/预算、会话及本次上下文；连接和默认网络无进展等待 5 秒，初次握手总期限 5 秒；单次 ID/内容，回执丢失只查询；完整验证后逐项 SAF 发布；sender sent 与 receiver 成功分开，URI/字节不跨桥；用法见移动 README |
| 清单前终态 | Android 下载在清单生成前取消/失败，生成逐文件 not-attempted 的接收终态 | TS 桥仅在本地下载终态、缺少清单、文件 ID/顺序/数量和原因均匹配时接纳；任何已写入结果继续要求完整清单/目标校验 |
| 生命周期 | 业务不判断前后台；普通目录、扫描、连接和查询不处理切后台后的成败。仅传输由 TransferRuntime 应用级持有，使用 dataSync 前台服务与持续通知，Activity 销毁后原传输继续 | 通知权限经用户允许；完成/显式取消和清理后退出；没有自动调度或旧任务重放，current 只重新取得原传输上下文 |

错误覆盖非法输入、版本不符、权限失效、不存在、不可读、不支持、名称冲突、路径越界、源变化、校验失败、网络失败、存储不足、IO/清理失败和结果待确认。未知属性是成功读取中的 null；选择取消和任务取消是独立结果，与读取错误分开。

## 5. 版本与线格式

数据声明和映射由共享包提供；Windows HTTP 读取使用严格 JSON/路由/头/会话和 UTF-8 字节预算，双端私有归档负责实际流、格式、长度与哈希校验。Windows HTTP receiver 负责上传预检、单次 PUT、完整校验与批次编排，Android 原生层负责单文件发布和网络/批次编排。当前协议使用批量 v1，只有批量端点，没有单文件别名，按正式兼容要求维护。完整声明见 `apps/shared/README.md`。

- 协议只接受数字版本 1，封闭 DTO 拒绝缺失和额外字段。ID 为 1–128 个 ASCII 字符，首位字母或数字，后续允许字母、数字、下划线和短横线，不接收路径或 URI；批内 fileId 使用受限连续编号。
- 字节数为非负安全整数；时间是 ±8.64e15 范围内的 Unix 毫秒整数，0 和负数有实际含义，未知修改日期用 null。文本非空白且最长 1024 个 UTF-16 码元。
- 新文件名最长 255 个 UTF-16 码元，路径字符、控制字符、未配对代理项、Windows 保留名和尾部点/空格会被拒绝；改名和归一化不会发生。内容哈希固定 64 个小写十六进制字符，只用于当前任务。
- JSON 使用 OperationResult 包络，重复键和非法 UTF-8 会被拒绝。查询 200 表示请求成功，任务是否成功要看 BatchState；POST uploads 的 201 表示任务已登记，POST downloads 和 PUT content 的 202 表示处理仍在进行。GET content 为原始 gzip，流开始后的失败通过接收校验和任务状态核实。
- 目标 name/parentId 进入 JSON 清单映射；目录读取的可选 parentId 仍为查询参数，省略表示根层。content 的 Content-Length 和 x-archive-sha256 均必填且与 manifest.archive 一致；接口不设置 Content-Encoding，提供单次完整传输，Range、续传和自动重放没有对应入口。路由/查询解码一次，歧义参数/头及非法编码会被拒绝。
- 错误映射包含 session-mismatch/task-conflict/plan-expired=409、invalid-archive=422、resource-limit=413、busy=429、timeout=408。network-failure 是本地错误，HTTP 状态为 null；完整定义见批量协议第 7 节。
- canRetry 用于核实当前状态后的用户新操作，自动重放不在范围内；unknown 表示远端状态待核实。取消与发布竞争时返回实际观察，已经发布的文件会保留。

## 6. 检查与验证边界

apps/shared 保留本地目录/设备/错误/选择结果守卫，并提供批量描述、选择/清单/目标请求、归档声明、进度/文件结果/批次状态守卫及 isBatchProgressAdvance。matchesBatchState(value, manifest, direction, receiver?) 对照本次清单和明确方向；receiver 必须提供完整 ReceiveBatchRequest，核对结果覆盖、字节/哈希、目标根/父目录/名称与重复最终条目。sender 只传 manifest 和方向。清单比较按内容，不按 JSON 键顺序，也没有历史存储。

长期自动化测试只保留共享数据关系、目录/IPC、归档、HTTP、原生发布和桥接边界。桌面与移动测试使用独立合成夹具，验证公开输入输出、文件安全、非覆盖发布、取消、结果未知和清理重试；不测试按钮、文案、DOM、颜色或内部调用顺序。Java 设备测试保留 SAF 只读读取、固定归档互通和实际 SAF 快照三条路径。真机结论和支持范围见 `docs/plans/m002-sync-copy.md` 第 6 节。

守卫校验已解析 JSON/plain data，处理范围是数据结构和关系；文件、网络、哈希计算、生命周期控制、脱敏由平台负责。守卫不改变、克隆或冻结输入；资源所有权、释放、线程隔离及原生异常到错误码的映射也在平台层。跨 Java/JS 的超范围整数在原生侧拒绝，未知属性显式输出 null；SAF 日期 0 依提供者约定转换为未知。调用示例及桥生命周期说明见 `apps/shared/README.md`、`apps/mobile/README.md`。

`pnpm check` 只执行文本、格式、lint、严格类型和双端构建。`pnpm test:all` 运行完整自动化测试与 Android 原生测试，日常检查不运行它。默认不新增或扩写自动化测试；功能验证优先编译、实际运行、ADB 操作和截图。

Windows 目录与 IPC 回归包含真实 8.3 短路径环境。真实目录只读，测试配置与夹具独立存放，不保存真实路径或文件哈希。

## 7. 游戏设备元数据与界面

传输发起的 `TransferRequest` 需要本机 `projectId`。共享 `resolveSyncProjectBinding` 固定本机/远端项目、设备与目录 ID；Android 在通知授权后重新交换目录表并复核，变化时要求重新预览。Android 开始比较时先只核对会话，重新交换目录表后才核对两端目录是否可用：存着的目录表可能是目录失效时交换的，先核对会挡住刷新，电脑目录恢复后也一直报授权失效。双端保存游戏只接受已登记本机目录，活动传输中阻止修改游戏目录/关联。HTTP 与 LibraryConfig 均为 v1。

`apps/shared/src/library/library.ts` 定义本机 `LibraryConfig`、公开 `CatalogGame`、游戏关联和目录表交换格式。一个游戏在每台设备对应一个目录，关联多个稳定设备 ID；首期同时连接一个对端，开始后的传输固定原连接。配置不保存文件清单、哈希或平台路径。

Windows 的 `DesktopLibrary` 在应用私有目录原子保存游戏/设备配置，通过有限 `desktopLibrary` IPC 提供读取、保存游戏、设备管理和移动端当前层查询。`POST /v1/catalog` 使用会话头、严格 JSON 边界与独立 DTO 校验；移动端提交自己的游戏目录表和明确的游戏关联，取回电脑目录表和关联。移动端只在本机目录表变化或收到 `catalog.changed` 后重新交换；电脑保存游戏后广播 `catalog.changed`；设备名只存本机，改名不通知对方。电脑读移动端目录经控制通道 `directory.list`，应答的根 ID 和父 ID 须与请求一致，父目录必须来自已读条目；同一层的并发读取共用一次请求。移动端原生 `exchangeCatalog` 绑定已连接电脑，原生填写本机设备 ID，不接受任意 URL。

在线以控制连接为准：电脑看控制连接是否打开，移动端看原生控制状态；移动端控制连接关闭 10 秒（或收到 4001）且没有活动任务时释放连接，活动传输仍保留原任务查询上下文。两端从已连接变为未连接时，通过 antd `message` 提示一次“连接已断开”；持续离线不重复提示，也不增加持久错误条或诊断断开原因。移动端主动连接失败也使用同一 `message`，颜色和圆角随本端明暗主题同步。

Android 桥提供 `connections`、`selectDevice`、`disconnectDevice`、`exchangeCatalog`；原生和界面均限制单连接。Activity 重建查询原生连接和当前任务，文件通道、持续通知和任务结果语义见第 4 节“Android 原生 HTTP/任务”。对端主动关联只合并公开元数据，目录写权限来自本机系统选择器；本机解除关联后记录排除项，避免下一次元数据交换自动加回。

新增设备的默认名称使用对端声明：Windows `/v1/device` 默认返回系统计算机名称，Android catalog 优先读取系统设备名称，读取失败或空值时使用型号，名称限 128 个 UTF-16 码元且截断不拆开代理对。重新连接或目录表交换不覆盖已保存的名称。

添加或导入游戏时先选择本机目录，选定后才能确认并写入游戏配置；取消不添加游戏。目录设置显示 `displayPath`，游戏名默认取 `parentName`，缺省时用 `displayName`。选择目录即为写入授权，界面没有单独的“允许接收”和“撤销接收授权”入口。Android 使用系统选择器保存持久 READ/WRITE 权限，每次下载前由 TransferRuntime 重新核实并恢复 publisher 授权；Windows 根据已保存的本机游戏目录，在上传接收前检查 rootId、目录身份与写权限。进程重启后继续使用已配置目录，权限失效时重新选择；只恢复目录写入授权，不恢复旧传输任务。

主动握手后的首个 catalog 请求携带 `x-sync-connect: 1`，之后的交换不携带。桌面断开只修改进程内会话并以 4001 关闭控制连接，不写入 `blocked=true`；断开后的普通交换收到 `session-mismatch`，移动端再次主动连接时清除标记。连接失败返回 HTTP 状态、协议码及原生 errno 或异常类型，不附加原因改写或重试建议。

界面由 `apps/desktop/src/renderer/src` 和 `apps/mobile/src` 各自维护，平台接入位于各端 `platform/library-adapter.ts`。`apps/shared` 提供协议、配置、任务数据、传输预检与游戏关联规则，不依赖组件库或平台 API。双端都有复制计划/结果、备份设置/列表和本机恢复，也都能发起复制和选择删除目标多出的条目。v1 批量文件传输只新建文件，不覆盖已有文件。

## 8. 发现与连接二维码

格式在 `apps/shared/src/connection`，字段和函数见 `apps/shared/README.md` 第 9 节。两种格式都由监听方提供、拨号方读取，不按平台区分；扫码只在移动端提供。拿到的地址只用来连接，连接后仍用 `/v1/device` 核对设备 ID，设备 ID 不一致时不替换已保存的设备。

- DNS-SD：服务类型 `_savedata-sync._tcp`，实例名是截到 63 个 UTF-8 字节的显示名，TXT 为 `v`、`id`、`pf`。地址和端口取 SRV 与 A 记录，拨号方只用 IPv4。
- 二维码：`savedata-sync://connect?v=1&id=<设备 ID>&p=<端口>&a=<IPv4>,…`，1–8 个地址按推荐顺序排列，拨号方依次尝试。电脑端设备页在服务运行时显示，载荷取服务快照的 `deviceId`、实际端口和 `listener.ipv4Addresses`；没有地址时不显示二维码。虚拟机、Hyper-V、代理软件的虚拟网卡不进二维码：其他设备访问不到，列出来会暴露本机内部网络，扫码端还会去连它所在网络里碰巧同址的主机。
- 电脑端广播：HTTP 服务监听期间由主进程广播，停止服务或退出应用时发 goodbye 包。SRV 主机名是 `savedata-sync-<设备 ID>`（小写，`_` 换成 `-`），不用显示名；只发 A 记录，每块网卡只回答这块网卡的地址。实例名重名时自动加序号。广播失败时 HTTP 服务照常运行，服务快照的 `discovery` 显示失败并每 30 秒重试；防火墙拦截 UDP 5353 时本机察觉不到。实现见桌面 README 第 3 节。
- Android 搜索：只在有页面订阅时用 NsdManager 搜索，Activity 停止时暂停；结果只含 IPv4 地址，TXT 由 `parseDiscoveryTxt` 校验后按设备 ID 合并，协议版本不同的只保留实例名。接口见移动 README“局域网设备搜索”。
- 版本：两种格式的 `v` 都是 `PROTOCOL_VERSION`。版本不同时解析结果为 `unsupported-version`，其余字段不解析；不合法时为 `invalid`。
