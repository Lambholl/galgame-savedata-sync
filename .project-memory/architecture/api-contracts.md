---
doc_type: api-contracts
status: active
updated: 2026-11-26
tags: [API, 接口约定]
---

# 接口约定

## 目录

- [1. 状态与范围](#1-状态与范围)
- [2. 共用数据语义](#2-共用数据语义)
- [3. 监听方 HTTP 接口约定](#3-监听方-http-接口约定)
- [4. 本地桥与错误边界](#4-本地桥与错误边界)
- [5. 版本与线格式](#5-版本与线格式)
- [6. 检查与验证边界](#6-检查与验证边界)
- [7. 游戏设备元数据与界面](#7-游戏设备元数据与界面)
- [8. 发现与连接二维码](#8-发现与连接二维码)

## 1. 状态与范围

本文记录当前接口。连接分监听方和拨号方：监听方提供 HTTP 服务和 `/v1/control`，拨号方连接并编排传输，监听方发起的传输经控制通道交给拨号方（[ADR-0004](../decisions/ADR-0004-symmetric-listener-dialer-roles.md)）。当前电脑既能作监听方，也能作拨号方连接另一台电脑并传输；Android 原生层同样能作拨号方和监听方，作监听方时提供连接、目录表交换、目录浏览和 `/v1/sync/*`，本机发起的传输经控制通道交给拨号方。下文写“电脑”“移动端”的地方是当前实现，规则按监听方和拨号方理解。平台说明见 [电脑端平台层](desktop.md)、[Android 平台层](android.md)，共享字段与线格式见[共享包](shared-package.md)。

已接入：游戏与设备配置、三页导航、并列目录视图、受保护覆盖、可选的目标多余条目删除、写入前全量备份、本机恢复和两端发起。发现与连接二维码的格式在 `apps/shared` 定义（第 8 节）：监听方广播并显示二维码，拨号方搜索和扫码（扫码只在移动端）；改址自动重连的安排见[路线图](../project/roadmap.md)。

文件内容双向统一采用 tar.gz（[Q-008](../requirements/open-questions.md)），归档格式和设备接口见[设备接口与归档格式](transfer-protocol.md)。监听方提供 v1 读取端点（`/v1/device`、`/v1/roots`、目录列举）和复制接口（第 3 节）。

## 2. 共用数据语义

| 模型 | 当前字段与约束 |
| --- | --- |
| DeviceDescriptor | protocolVersion=5（`PROTOCOL_VERSION`）、deviceId、displayName、platform（`windows`、`linux` 或 `android`）、capabilities；稳定 ID 与地址分离 |
| DirectoryReference | rootId、deviceId、displayName、authorization；授权状态 granted/expired/unavailable/unverified；可选 displayPath 是完整展示路径或提供者地址，parentName 是可取得的父目录名。两个字段只用于展示和默认游戏名，文件操作只传不透明引用；目录表随 `/v1/roots` 发给对端时带着 displayPath，对端在关联设备列表里显示为对端的存档路径；守卫也接受不含这两个字段的格式 |
| EntryMetadata | rootId、entryId、parentId、name、kind、sizeBytes、modifiedAt、capabilities；file/directory 联合；根层 parentId=null，parentId 不指向自身；文件夹大小恒为 null，文件未知大小为 null，空文件为 0 |
| DirectoryListing | rootId、parentId、observedAt、entries；成功空数组表示空目录；条目须属于同一根/层且 ID 不重复；错误用独立包络 |
| EntryCapabilities / DeviceCapabilities | 条目能力 canRead/canList/canCreate/canRename/canDelete；设备能力只有 canListRoots（目录浏览），复制能力由 `/v1/sync/capabilities` 报告；各值 supported/unsupported/unknown |
| OperationError / OperationResult | code、message、canRetry，以及确定是哪一端访问文件或目录失败时才有的 device（listener 表示监听方，dialer 表示拨号方；拨号方准备阶段产生并经 sync.report 转给监听方。HTTP 错误包络里只有 Android 监听方带 device：本机目录失败、内容 GET 和 PUT 回给拨号方的文件访问类错误都注明 listener；两端拨号方解析 HTTP 错误时保留 device）；Android 任务状态的 error 也带 device：本机文件访问和授权失效是 dialer，转抄监听方报来的文件错误是 listener，取消和超时不带；其余任务错误由 locateSyncError 按方向和中断阶段标出一端，打包阶段的授权失效不按阶段推断；互斥 success/value 与 error/error 包络；result-unknown 的 canRetry 必须为 false；自有错误原文默认英文并由生产者脱敏。界面按 code 翻译，message 与 code 在电脑上悬停可见，任务详情写进技术详情；unwrap 抛带 code 的 OperationFailure，toShownError 转为 ShownError，缺少 code 时保留原文 |
| DirectorySelectionResult | selected 携带 directory，cancelled 不携带目录或错误，error 携带错误；取消不清空既有有效引用 |
| BatchDeviceDescriptor | `GET /v1/device` 的返回值：包装 device，加 sessionId 和固定 limits；本地目录桥的返回值不含这些字段 |

提供者可能不保留源修改时间，写入后查询并展示目标实际元数据。同步复制按类型、大小和修改日期（相差不超过 2 秒算相同）判断文件是否相同。

## 3. 监听方 HTTP 接口约定

`apps/shared/src/sync` 提供独立 schema 1 的当前扫描、复制/本机恢复计划、备份清单/设置和逐项结果。`createSyncPlan` 只处理本次快照；`isSyncPlan` 重新推导动作与计数，执行方以 `matchesSyncPlan` 对照持有的当前输入，以 `matchesSyncApplyResult` 核对完整结果和实际指纹。规则统一见[复制、备份与恢复约定](sync-copy.md)。

监听方提供 `/v1/sync/capabilities`、`POST /v1/sync/scans` 和 `GET/DELETE /v1/sync/scans/{scanId}`，使用会话头和严格 JSON；登记仅接收 schemaVersion/rootId，202 后查询 SyncScanState。电脑的有限 desktopService 桥提供 startScan/queryScan/cancelScan，校验本机来源、参数和返回引用。扫描只读，完整指纹、空目录和失败的部分结果分开；取消时关流，结果会到期，每端最多保留 32 份，满时丢掉最旧的，停止或重启后更换会话。监听方同时只跑一个扫描，拨号方遇到 busy 会重试最多 5 秒。电脑写入时把候选文件放在目标文件的同一目录，名称由 shared `writeCandidateName` 生成，形如 `.savedata-copy-<UUID>.tmp`、`.savedata-new-<UUID>.tmp`，UUID 小写。写入途中进程被结束会留下这些候选文件，处理分两步：电脑扫描按 `isWriteCandidateName` 精确匹配后跳过它们，所以它们不进入快照、比较和计划，扫描仍然只读；`DesktopSyncWriter` 开始写目标目录时，先删除目标根目录下所有候选文件，不进入链接指向的目录，删不掉的跳过，下次写入再删。这时持有写入名额，且电脑端有单实例锁，所以目标里的候选文件都是残留。Android 不写候选文件，电脑扫描又跳过残留，不会把它们传给 Android，所以 Android 扫描不做这项处理。

双向复制协议：监听方提供只读项目描述、任务登记、单次内容上传（chunked PUT）及源准备/单次内容 GET、查询/取消；内容是按计划写文件顺序排列的 tar.gz 流，发送端边读边打包，接收端边收边解包到私有目录。接收端登记任务后立即开始备份，备份与传输同时进行，备份完成且内容收齐后重新核对目标再写入：拨号方 → 监听方由监听方完成，监听方 → 拨号方由拨号方完成。监听方在备份或等待内容阶段接收上传；内容没收齐时任务失败，一项都不写；备份或核对先失败时监听方中止接收，上传方得到 task-conflict。一端停下会关掉内容连接，另一端只能看到连接断开，所以用户取消时先通知对端取消再停下本机：拨号方发起时先 DELETE 监听方的任务（监听方无回应时最多等 5 秒），监听方发起时在等待拨号方回应期间，本机任务因连接断开中止也记为取消。拨号方上传连接断开后最多等 5 秒，让监听方自己按连接断开结束，仍在等内容才按网络中断结束并取消监听方的任务。任务固定当前会话扫描、双向项目关联、设备/根及发起端的备份选择；实际同步通信更新既有设备在线时间。监听方源准备异步返回 preparing，扫描资源释放后发布 ready，发送完成只报告 sent。拨号方下载前合计缓存/备份/已知同卷增量，写入器借用确认时的名额和时间并重新扫描目标；完整 receiver 结果与发送状态分开。全任务保持进程互斥至清理结束，回执丢失只查询，内容不重放，零文件没有归档。Android 的 SyncTransfers 有限桥分开普通扫描准备、同次确认、状态及取消/释放，只有确认执行启动传输通知；页面重建后可取回原生预览核对结果。本机恢复经本地桥提供，没有远端恢复入口。完整字段与期限见[复制、备份与恢复约定](sync-copy.md)第 6、7 节。

设备间控制走 WebSocket `/v1/control`，文件内容走 HTTP 路由。拨号方先完成 `POST /v1/catalog` 交换，再带 `x-sync-session-id` 和 `x-sync-device-id` 升级；监听方核对会话、设备已交换目录表、未停用、未被断开且没有另一台设备在线，不满足返回 403。消息格式对称，双方都能发请求、回应答、推事件：`{v:1, type:request|response|event, id?, method, body|result}`，单条最多 8 MiB，只收文本帧，JSON 严格解析（重复键、非法 UTF-8 关闭 1007，格式不符关闭 1008）。请求方法有 `directory.list`、`poster.read`（见[游戏封面](poster.md#7-对端封面)）、`sync.prepare`、`sync.confirm`、`sync.cancel`、`sync.job.read`、`sync.job.cancel`，事件有 `catalog.changed`、`sync.report` 和 `sync.job`；请求 8 秒无应答即失败。监听方每 15 秒 ping，一个周期无 pong 就断开。关闭码 4001 表示监听方断开了这台设备，拨号方不再重连；4002 表示同一设备的新连接取代旧连接；其他关闭时拨号方 2 秒后重连。格式和守卫在 `apps/shared/src/control`，电脑 `control-hub.ts`（ws）监听、`dialer-control.ts`（ws）拨号，移动端 `ControlClient.java`（Java-WebSocket）拨号，网页经 `platform/control-channel.ts` 收发。两端须同版，没有轮询回退。一台设备同一时刻只有一条控制连接：作为监听方被连着，或作为拨号方连着别人；拨号方连着别人时，本机监听服务对新的 `POST /v1/catalog` 返回 `busy`。两端都能作监听方和拨号方，四种组合都已实现（REQ-022）；Android 监听方的传输还没在真机上验证，见[回归状态](../testing/regression-notes.md)。

监听方发起的复制经控制通道交给拨号方，复用拨号方的扫描与执行。电脑 `remote-sync-requests.ts` 和 Android `ListenerSyncRequests` 同时只保留一个请求：发起时发 `sync.prepare {requestId, projectId, direction}`，拨号方应答后开始扫描，用 `sync.report` 回报 preparing、ready（附计划）或 failed。拨号方有传输刚结束时最多等 2 秒再判断是否 busy；新扫描取代还没结束的旧扫描，等待期间被取消或被更新请求取代的 `sync.prepare` 只应答、不扫描；ready 计划须是对应项目、方向、设备和根的覆盖复制。`sync.report` 附的计划固定 `shouldDeleteExtras=false`，监听方确认后发 `sync.confirm {requestId, shouldDeleteExtras}`，两端用同一批快照各自算出选定的计划；拨号方执行并应答 `{jobId}`，jobId 等于 planId 时记为 running；之后的进度和结果来自下面的任务观察。监听方取消发 `sync.cancel`，拨号方取消并释放本机扫描；控制连接断开时未确认的请求记为失败，已确认的请求记为结果待确认，拨号方重连后由摘要更新。电脑的有限 desktopSync 桥提供 remoteRequest/startRemote/remotePlan/confirmRemote/cancelRemote。

任务观察对两种发起方式、两个方向相同。版本：`/v1/sync/capabilities.schemaVersion` 为 8，是唯一的版本门槛，版本不符的对端在创建任务前得到“请更新两端”；控制消息 `v` 为 1。`SyncJobState.schemaVersion` 为 5，含 `failureStage`（失败、取消或待确认时停在哪个阶段，取值为 cleaning、done 以外的阶段；成功、已发送或没有记录时为 null，清理和终态更新不改写它）。`SyncTransferState` 为 1。

进度 `SyncJobProgress` 有七个字段：`transferredBytes`（已打包或已解包的文件内容字节数，不含 tar 头和压缩开销）、`totalFileBytes`、`totalFiles`、`publishedFiles` 和 `fileBytesPublished`（接收端已写入目标的文件数和字节数）、`backupBytesCopied` 和 `totalBackupBytes`。界面按备份、传输、写入三步显示，分别用备份字节、传输字节和已写入字节算百分比（写入总字节为 0 时用已写入文件数）；接收端处于备份阶段时整个任务显示为备份。计划没开备份（`shouldBackup` 为 false）时只显示传输、写入两步，准备阶段并进传输步（shared `syncTaskSteps`）；任务状态里没有备份选择，界面从计划读取，电脑端的复制摘要带 `shouldBackup`。接收端不备份时也经过 `backing-up`（写入前核对目标），这时阶段名显示为准备（shared `syncStageLabel`）；Android 通知拿不到计划，按 `totalBackupBytes` 为 0 显示准备。`publishedFiles` 在每个文件写完时加一；`fileBytesPublished` 每写一块更新一次，包含正在写的文件已写入的字节数，文件写完、计数加一之前已包含它的全部字节，所以 `publishedFiles` 为 0 时 `fileBytesPublished` 可以大于 0，`publishedFiles` 等于 `totalFiles` 时 `fileBytesPublished` 等于 `totalFileBytes`。写入中途失败时任务随即结束，两端接收方结束时都按实际结果重算这两个字段，只计写入成功的文件，失败任务的 `fileBytesPublished` 因此可能小于写入中显示的值。`totalBackupBytes` 等于计划的 `backupFileBytes`（由 shared `syncJobBackupBytes` 算出，计划里为 null 时为 0），两端都按计划核对；`backupBytesCopied` 是接收端备份时已写进备份的字节数，每写一块更新一次，只增不减，发送端始终为 0，接收端成功时等于总量。写完后重读核对备份文件和轮换不计入进度。`observeSyncJob` 用这两个字段算备份段的百分比，总量为 0 时百分比未知。Android 通知在备份阶段按同样的字段显示百分比，写入阶段和详情页一样按 `fileBytesPublished` 显示。

| 消息 | 方向 | 内容 | 失败含义 |
| --- | --- | --- | --- |
| 事件 `sync.job` | 拨号方 → 监听方 | `SyncJobDigest`：`SyncJobState` 去掉逐项 result。有变化时发，进行中每秒至少一次，检查周期 500ms；只在发送成功后记为已发，断开期间的变化重连后补发 | 未知任务或别的设备的摘要被忽略；角色、方向、总量与计划不符时记 result-unknown |
| 请求 `sync.job.read {jobId}` | 监听方 → 拨号方 | 完整 `SyncJobState`。只在接收端结束后读一次，取得逐项结果 | 任务不存在或属于别的设备返回 not-found；失败时每 5 秒重试，其间显示结果待确认 |
| 请求 `sync.job.cancel {jobId}` | 监听方 → 拨号方 | null。拨号方记录为用户取消，而不是网络失败；已结束的任务不受影响 | 拨号方还没建立任务时返回 not-found，监听方报告操作失败 |

这三项在拨号方由任务引擎处理（Android `SyncTransferEngine`、电脑 `dialer-sync.ts`），不经页面，页面被回收或任务由拨号方发起时同样工作。角色状态互相独立，成功只看接收端的读回结果：`observeSyncJob(local, remote, hasRemoteError)` 合成阶段、当前段百分比、失败阶段和计数，发送端结束而接收端未结束时仍是进行中。结束后的结论依次判断：接收端成功为 done；接收端待确认为 unknown，有成功项也一样，没确认的条目可能已写入；其余有成功项为 partial。界面的部分完成说明只列不为 0 的成功、失败、待确认、未执行，取消和未尝试的条目算未执行；完成说明把文件、新建文件夹和删除分开计数。清理失败时，任务条在传输成功时只写清理失败，其他结论后面接着写清理失败。对端状态不可信（控制通道断开、60 秒没有摘要、结果读取失败）时 `remoteError` 为 result-unknown，本机也结束后显示待确认，新的摘要或结果会清除它。监听方作为接收端还没收到内容时，拨号方摘要报失败或取消就取消监听方这一端；在准备阶段 60 秒没有摘要，按超时结束。

电脑侧 `copyState`、`cancelCopy` 返回 `SyncTransferState`，`DesktopCopySummary` 用 phase、stage、step、percent 表示进度，由后端计算，详情、游戏进度条、历史和完成提示读同一份，高频更新不携带逐项结果。已确认但拨号方还没登记任务时，`remote-sync-requests.ts` 用同一个 jobId 提供占位的摘要、计划和状态，摘要的 `isAwaitingPeer` 为 true，详情和任务条写“等待对方设备开始”；登记后改由 `DesktopSyncRegistry` 提供。对端未结束的任务不会被留存清理，也算作有运行中的工作。

备份展示字段、`sync.confirm` 的 `shouldBackup` 和计划的 `shouldDeleteExtras`、`delete-file`、`delete-directory` 由 `/v1/sync/capabilities.schemaVersion` 一起覆盖，两端须同版，封闭 DTO 严格校验。计划动作的执行顺序是新建文件夹（由浅到深）、写文件、删除（由深到浅，同深度按路径），两端必须算出相同顺序。恢复计划固定 `shouldDeleteExtras=true`，将目标目录还原为备份时的内容集合。文件在删除前核对身份、大小和修改日期；文件夹只删空的或只剩 `.nomedia` 的，有 `.nomedia` 时先删它；Windows 用非递归 `rmdir`，Android 的 `deleteDocument` 会递归，所以先确认文件夹里没有别的条目。系统已开始删除但结果没能确认时报 result-unknown。

| 字段 | 位置 | 含义 | 失败或未知 |
| --- | --- | --- | --- |
| `backupFileCount` | `SyncApplyResult` | 本次已提交备份清单里的文件数，来自实际清单，不用计划数估算 | 没有备份时 null；有 backupId 而为 null 时只说“已备份” |
| `incomplete: {backupId, occupiedBytes}[]` | 双端备份列表（Windows 与 Android 桥） | 未提交轮次及其占用字节数，还包括文件被用户删除或大小不符的备份 | 读不到为 null，界面显示大小未知，与 0 字节分开 |

备份按游戏归组：本机备份桥的列出、读清单、轮换、清理和删除都只按 `projectId`（加 `backupId`）查找，不带 rootId。游戏换了目录后，旧目录的备份照常列出、参与轮换，恢复写进游戏当前的目录；备份清单里的 rootId 只记录备份时的目录。备份库设置 `SyncBackupSettings` 为 `{schemaVersion: 4, keepCount}`，只有一个保留份数；其他版本按读不懂的数据文件处理。这是本机文件格式，不影响能力版本。

删除备份只走本机受限桥，不经网络：电脑 `desktopBackups.deleteBackup(projectId, backupId)`，移动端 `SyncBackups.deleteBackup` 同参数。已不存在的算删除成功，因为用户可能已在文件管理器里删掉；被恢复引用或有传输、恢复运行时返回 busy；中途失败时轮次变成未完成残留，可用清理入口重试。移除游戏时先调 `deleteGameBackups(projectId)`（两端同名），删掉这个游戏在所有目录下的轮次和残留，成功后才保存游戏配置；失败时游戏保留，可以重试。存档文件不动。

按游戏查询：移动端 `SyncTransfers.latest({projectId})` 只查进程内任务登记表，返回该本机项目最近的 jobId 或 null，之后用 query/preview 读取；留存期和容量与任务登记表相同，进程重启后没有记录。全局活动判断用 `current()`。本机设备名：移动端 `HttpTransfers.deviceName()`，电脑 `DesktopServiceSnapshot.deviceName`，取值规则与发给对端的相同；读取失败为空，界面留空，不用对端保存的名称。

共享包导出以下 v1 读取路由常量和 DTO；完整字段、状态码、固定上限和归档格式以[设备接口与归档格式](transfer-protocol.md)为准。

| API | 方法 | 请求 | 响应 | 错误边界 |
| --- | --- | --- | --- | --- |
| /v1/device | GET | 无 | BatchDeviceDescriptor：device、sessionId、limits | 版本不兼容时客户端停止文件操作 |
| /v1/roots | GET | 无 | 本机用户已选择的根目录描述 | 只枚举本机已选择的根目录 |
| /v1/roots/{rootId}/entries | GET | 可选 parentId；省略表示根层 | 当前层条目及读取时间 | 非法引用、目录失效、不可读与空目录分别表达 |

路由参数和归档成员都必须验证。parentId 是目录引用；归档成员必须与复制计划的 fileId、大小和顺序一致，接收端按 fileId 解包到私有缓存，写盘使用计划里的目标路径，不使用归档路径。Windows 解析引用时还要校验真实根目录边界，拒绝符号链接/junction 越界，也不接收主机绝对路径。共享守卫只检查数据；平台权限、实际路径与名称竞争由各平台检查。

服务以每次启动的 sessionId 隔离复制任务，除设备描述外要求 x-sync-session-id；任务 ID 只属于当前会话，每个会话最多接纳 `maxTransfersPerSession` 个。服务重启或响应丢失时，远端可能已经写入；重新读取目标确认，不自动重放旧任务。

## 4. 本地桥与错误边界

| 边界 | 可传递的内容 | 限制 |
| --- | --- | --- |
| Android 复制与恢复界面适配器 | createMobileSyncAdapter 从保存配置固定设备/项目/根，提供准备、固定预览、按两个开关确认执行、当前任务、取消、保留份数和恢复入口；useSyncTasks 只轮询原生所有者 | 通知授权后重查映射，方向或目录变化后重新扫描确认；sender sent 后目标仍运行时继续只读查询同一 ID；页面卸载不取消任务，重建只查询，不重放执行；`interruptedWrites`/`dismissInterruptedWrite` 读取并一次性清除上个进程留下的写入标记；失败、部分、未知与清理结果分开显示，详细参数见 [Android 平台层](android.md) |
| Windows 同步与恢复界面桥 | desktopSync 提供复制摘要/计划/状态/取消/清理，以及本机恢复准备/预览/确认/状态/取消/清理/释放；DesktopRestoreState 含固定项目/目录/输入备份、阶段、isWorking、实际文件进度及结果/独立清理错误 | 固定 sync:* 通道、capability 限定的调用页面、封闭 ID 参数、同次原生计划和 8 MiB 响应校验；摘要最多 33 份（32 份已登记任务加一份待移动端登记的任务），准备不占目标名额，确认后持有到清理成功；刷新可查询本进程任务，重启只保留配置/备份和写入标记；`interruptedWrites`/`dismissInterruptedWrite` 读取并一次性清除上个进程留下的标记；电脑发起的桥方法见第 3 节，没有远端恢复；接口及错误见[电脑端平台层](desktop.md)第 13、14 节 |
| 桌面目录桥 | chooseDirectory、listRoots、listDirectory；只接受 ID，返回公开 DTO；系统选择器由 Tauri 宿主应 sidecar 请求打开 | 无 fs/shell/Node、绝对路径、内容或写入接口；页面只能调用 `backend_invoke`，capability 只授权 `main` 窗口 |
| 桌面服务桥 | desktopService 的 status/start/randomizePort/stop/chooseTarget 和扫描 startScan/queryScan/cancelScan；状态含 deviceId、deviceName、configuredPort、实际端口与 startedAt（Unix 毫秒）、其他设备可能访问到的本机 IPv4 地址 ipv4Addresses（先取物理网卡且有默认网关的地址，没有时取任意有默认网关的地址，再加 Windows 移动热点 192.168.137.1；排除 198.18.0.0/15；一个都没有时退回全部可用地址；按推荐顺序、去重，最多 8 个）、错误和广播状态；服务启动后地址还在读取时 ipv4Addresses 为 null，查询失败或没有候选时为空数组 | 参数/DTO 校验；start 端口为 1..65535，显式监听 0.0.0.0；首次生成并保存 49152..65535 随机端口，后续读取既有值；randomizePort 排除当前值并保存，运行时拒绝修改；卸载停止轮询 |
| 电脑端后端原生读取 | registerDirectory 把系统选中路径解析成真实路径后登记，listDirectory 返回当前层的普通文件和文件夹，openFile 返回本进程只读流 | 配置独立存放，没有历史清单；调用者消费或 destroy 流；逐段拒绝 symlink/junction，重查根/条目/句柄身份；恶意并发命名空间不在原子隔离范围内 |
| Windows 独立备份与本机桥 | createDesktopBackupStore 的 create/list/settings/setKeepCount/capacity/acquire/rotate/cleanupIncomplete/stop；desktopBackups 提供只读摘要/单轮清单、保留份数、显式清理、openFolder、手动备份和更换备份库位置，创建与原生恢复流不跨桥 | 备份库与同步根隔离，结构和移动端相同（`<游戏名>/<UTC 时间>/` 内含 backup.json 和按原路径保存的 files/）；内容校验、落盘和回读后提交，按保留份数轮换（默认 10 份）并保护恢复材料引用的轮次；失败创建不返回有效轮次，轮换错误独立；位置 displayPath 仅供展示，界面通道无文件路径参数或内容，openFolder 打开的路径由后端决定；具体参数和资源责任见[电脑端平台层](desktop.md) |
| Windows 受保护写入与恢复 | DesktopSyncWriter.apply/prepareRestore/checkSpace/retryCleanup/stop；材料为匹配快照和可重复原生读流，返回 SyncApplyResult；DesktopSyncScanner.wait 供原生等待同次扫描 | 整批目标/原文复核、峰值容量及完整备份后创建目录/逐文件发布/回读；复制和本机恢复共用进程写入名额（`TargetOperation`），候选清理失败保留名额，恢复强制备份且引用输入；原生 authorize 核对项目/根，HTTP 和本机恢复编排借用全任务名额并反复核实上下文；接口及资源责任见[电脑端平台层](desktop.md)第 13、14 节 |
| Windows HTTP 原生服务 | DesktopHttpService 显式 start/stop、地址/错误查询；提供设备描述、目录读取、目录表交换、控制通道和 `/v1/sync/*`，复制任务由 `DesktopSyncRegistry` 登记 | 构造及应用启动不监听网络，默认回环；受限 IPC 提供服务控制、扫描和复制摘要；应用退出等待 HTTP 和任务停止；无文件字节跨桥 |
| Windows 私有归档 | createDesktopArchiveAdapter、checkStagingSpace、sendFiles/receiveFiles、retryCleanup；receiveFiles 返回解包后的 openFile/dispose；source 仍只读；目录流提供 verifyUnchanged 与缓存隔离检查 | 不返回可供 Renderer 使用的路径/句柄；按计划逐成员核对并通过 gzip CRC32、ISIZE 校验后返回私有缓存；HTTP 和目标写入交给上层；调用者关闭流并 dispose，清理失败另报 cleanupError |
| Capacitor Directories 插件 | chooseDirectory/listRoots/listDirectory；系统选择器与 READ 持久授权、当前层元数据和本地 ID；原生读写只经 `DocumentAccess`，有所有文件访问权限且目录属于系统存储提供者时按路径读写，两种实现返回相同的 ID 和属性 | URI/documentId 留在原生层，不接收任意路径；写入能力均不支持；原生只读流由同包调用者消费并关闭，不将内容或 Base64 交给 JS |
| Android 当前扫描 | SyncScansPlugin 的 capabilities/start/query/cancel；start 接收 schemaVersion=1/rootId，query/cancel 接收 scanId，返回 OperationResult 包络及共享 SyncScanState | 本次递归读取及原生 SHA-256；未知长度按流实测，源变化/权限/预算/取消分别报告；结果限时存内存，不加保活或前后台处理；调用见[Android 平台层](android.md) |
| Android 独立备份 | BackupStore/Model/Files、AndroidBackupIo、ManualBackupRuntime 提供 `Android/data` 中备份的创建、本机异步手动备份、校验、按份数（1–4096）平级轮换、设置/容量及恢复材料引用；SyncBackupsPlugin 提供 read/list/manifest/setKeepCount/rotate/cleanupIncomplete/deleteBackup/deleteGameBackups 及 startManual/currentManual/manualState/cancelManual | 写入前备份由原生确认计划编排调用，手动备份由应用级 `ManualBackupRuntime` 在 Activity 销毁后继续执行；设置、手动备份及显式维护争用与传输/恢复相同的目标名额，实际任务清理前拒绝变更。SAF 读取后校验，按 `backups/游戏名/UTC 时间/` 落盘/回读/提交，用户可直接删除；设置在内部 backup-settings.json；查询仅公开 ID/摘要/清单/状态，displayPath 仅供展示；不跨桥传内容/句柄，不提供备份目录选择；错误与资源责任见[Android 平台层](android.md) |
| Android 受保护写入与本机恢复 | SyncPlanModel 重算可执行计划，SyncWriter.apply 与 DirectorySyncBackend 执行原生目标写入；SyncWrites/TS bridge 提供 bindProject/prepareRestore/preview/execute/query/current/cancel/release/retryCleanup | 平台从保存配置绑定项目/根，原生检查持久写权限和固定预览；完整输入/目标复核、容量和有效备份后创建/覆盖/回读，rw 不预截断；本机恢复强制保护当前内容。current 返回活动或最近恢复 ID，页面据此找回预览和结果；清理失败记录继续保留，明确重试后更新清理状态。输入引用/取消/清理与实际结果分开，仅公开 DTO/ID，不公开 URI/路径/流；详见[Android 平台层](android.md) |
| Java 私有归档 | ArchiveAdapter 的 checkStagingSpace、sendFiles/receiveFiles、retryCleanup；receiveFiles 返回 Staged.openFile/close；源文件经 ArchiveModel.Source 读取并前后复核；ArchiveControl 取消时关闭读流，资源、期限与清理错误分别检查 | 按计划逐成员核对并通过 gzip CRC32、ISIZE 校验后才返回句柄；私有缓存路径和所有权进程独占，清理失败保留名额可重试；无 URI/内容跨桥；网络、目标写入与前台调度由对应模块负责；用法见[Android 平台层](android.md) |
| Android 原生连接 | HttpTransfersPlugin、TransferSchema/Http/Engine、TS 桥；connect/disconnect、连接列表与选择、目录表交换、控制通道、远端根和当前层、本机设备名、通知权限和 chooseTarget | 严格 JSON/头/预算和会话；连接和默认网络无进展等待 5 秒，初次握手总期限 5 秒；`TransferRuntime` 持有进程内唯一的 `TransferEngine`；URI/字节不跨桥；用法见[Android 平台层](android.md) |
| 生命周期 | 业务不判断前后台；普通目录、扫描、连接和查询不处理切后台后的成败。复制任务由 `SyncTransferRuntime` 应用级持有，使用 dataSync 前台服务与持续通知，Activity 销毁后原任务继续 | 通知权限经用户允许；完成/显式取消和清理后退出；没有自动调度或旧任务重放 |

错误覆盖非法输入、版本不符、权限失效、不存在、不可读、不支持、名称冲突、路径越界、源变化、校验失败、网络失败、存储不足、IO/清理失败和结果待确认。未知属性是成功读取中的 null；选择取消和任务取消是独立结果，与读取错误分开。

## 5. 版本与线格式

数据声明和映射由共享包提供；监听方 HTTP 使用严格 JSON/路由/头/会话和 UTF-8 字节预算，双端私有归档负责实际流、格式和长度校验。完整声明见[共享包](shared-package.md)。

- 设备描述只接受数字版本 5（`PROTOCOL_VERSION`）；封闭 DTO 拒绝缺失和额外字段。ID 为 1–128 个 ASCII 字符，首位字母或数字，后续允许字母、数字、下划线和短横线，不接收路径或 URI；复制内容的 fileId 使用受限连续编号。
- 字节数为非负安全整数；时间是 ±8.64e15 范围内的 Unix 毫秒整数，0 和负数有实际含义，未知修改日期用 null。文本非空白且最长 1024 个 UTF-16 码元。
- 新文件名最长 255 个 UTF-16 码元，路径字符、控制字符、未配对代理项、Windows 保留名和尾部点/空格会被拒绝；改名和归一化不会发生。
- JSON 使用 OperationResult 包络，重复键和非法 UTF-8 会被拒绝。查询 200 表示请求成功，任务是否成功要看任务状态。复制内容为原始 gzip，流开始后的失败通过接收校验和任务状态核实。
- 目录读取的可选 parentId 为查询参数，省略表示根层。复制内容的上传和下载只用 chunked 传输，不带长度和哈希头；接口不设置 Content-Encoding，提供单次完整传输，Range、续传和自动重放没有对应入口。路由/查询解码一次，歧义参数/头及非法编码会被拒绝。
- 错误映射包含 session-mismatch/task-conflict/plan-expired=409、invalid-archive=422、resource-limit=413、busy=429、timeout=408。network-failure 是本地错误，HTTP 状态为 null；完整定义见 shared `HTTP_ERROR_STATUS`。
- canRetry 用于核实当前状态后的用户新操作，自动重放不在范围内；unknown 表示远端状态待核实。取消与写入竞争时返回实际观察，已经写入的文件会保留。

## 6. 检查与验证边界

apps/shared 保留本地目录/设备/错误/选择结果守卫、设备描述和固定上限守卫（`isBatchDeviceDescriptor`、`isBatchLimits`），以及复制计划、任务状态和结果守卫（第 3 节）。

长期自动化测试只保留共享数据关系、目录/IPC、归档、HTTP、原生写入和桥接边界。桌面与移动测试使用独立合成夹具，验证公开输入输出、文件安全、非覆盖发布、取消、结果未知和清理重试；不测试按钮、文案、DOM、颜色或内部调用顺序。Java 设备测试保留 SAF 只读读取、固定归档互通和实际 SAF 快照三条路径。真机结论和支持范围见[验收标准](../testing/acceptance.md)。

守卫校验已解析 JSON/plain data，处理范围是数据结构和关系；文件、网络、哈希计算、生命周期控制、脱敏由平台负责。守卫不改变、克隆或冻结输入；资源所有权、释放、线程隔离及原生异常到错误码的映射也在平台层。跨 Java/JS 的超范围整数在原生侧拒绝，未知属性显式输出 null；SAF 日期 0 依提供者约定转换为未知。桥生命周期说明见[共享包](shared-package.md)、[Android 平台层](android.md)。

`pnpm check` 只执行文本、格式、lint、严格类型和双端构建。`pnpm test:all` 运行完整自动化测试与 Android 原生测试，日常检查不运行它。默认不新增或扩写自动化测试；功能验证优先编译、实际运行、ADB 操作和截图。

Windows 目录与 IPC 回归包含真实 8.3 短路径环境。真实目录只读，测试配置与夹具独立存放，不保存真实路径或文件哈希。

## 7. 游戏设备元数据与界面

传输发起的 `TransferRequest` 需要本机 `projectId`。共享 `resolveSyncProjectBinding` 固定本机/远端项目、设备与目录 ID；Android 在通知授权后重新交换目录表并复核，变化时要求重新预览。Android 开始比较时先只核对会话，重新交换目录表后才核对两端目录是否可用：存着的目录表可能是目录失效时交换的，先核对会挡住刷新，电脑目录恢复后也一直报授权失效。双端保存游戏只接受已登记本机目录，活动传输中阻止修改游戏目录/关联。HTTP 路由为 v1，`LibraryConfig` 的 `schemaVersion` 为 2。

`apps/shared/src/library/library.ts` 定义本机 `LibraryConfig`、公开 `CatalogGame`、游戏关联和目录表交换格式。一个游戏在每台设备对应一个目录，关联多个稳定设备 ID；首期同时连接一个对端，开始后的传输固定原连接。配置不保存文件清单、哈希或平台路径。已保存的设备记录对方平台（`windows` 或 `android`），两端设备页按它显示图标。

Windows 的 `DesktopLibrary` 在应用私有目录原子保存游戏/设备配置，通过有限的 `desktopLibrary` 通道提供读取、保存游戏、设备管理和移动端当前层查询。`POST /v1/catalog` 使用会话头、严格 JSON 边界与独立 DTO 校验；拨号方提交自己的设备 ID、名称、平台、游戏目录表和明确的游戏关联，取回监听方目录表和关联；监听方按提交的平台保存拨号方，拨号方按 `/v1/device` 的平台保存监听方。拨号方只在本机目录表变化或收到 `catalog.changed` 后重新交换；监听方保存游戏后广播 `catalog.changed`；设备名只存本机，改名不通知对方。监听方读拨号方目录经控制通道 `directory.list`，拨号方读监听方目录经 HTTP 目录列举；`directory.list` 应答的根 ID 和父 ID 须与请求一致，父目录必须来自已读条目；同一层的并发读取共用一次请求。移动端原生 `exchangeCatalog` 绑定已连接电脑，原生填写本机设备 ID，不接受任意 URL。电脑作拨号方时由后端 `dialer-session.ts` 交换目录表，渲染进程只能给出地址或已保存设备的 ID。

在线以控制连接为准：监听方看控制连接是否打开，拨号方看本机控制状态（Android 原生层或电脑端后端）；拨号方控制连接关闭 10 秒（或收到 4001）且没有活动任务时释放连接，活动传输仍保留原任务查询上下文。两端从已连接变为未连接时，通过 antd `message` 提示一次“连接已断开”；持续离线不重复提示，也不增加持久错误条或诊断断开原因。拨号方连接失败也使用同一 `message`，颜色和圆角随本端明暗主题同步。

Android 桥提供 `connections`、`selectDevice`、`disconnectDevice`、`exchangeCatalog`；原生和界面均限制单连接。Activity 重建查询原生连接和当前任务，连接和持续通知见第 4 节“Android 原生连接”“生命周期”。对端主动关联只合并公开元数据，目录写权限来自本机系统选择器；本机解除关联只改本机配置，对端仍会报这条关联，所以解除的关联（设备 ID 加对端游戏 ID）记进该游戏的 `excludedLinks`，合并时跳过；对端之后新导入或新关联的游戏 ID 不同，照常合并。`excludedLinks` 最多 `LIBRARY_LIMITS.maxDevices` 条，超出时丢掉最早的；配置里的 `excludedDevices` 字段读取时忽略。对端有几个游戏关联同一个本机游戏时，优先本机已关联的那条，否则取第一条。合并关联（共享 `mergeCatalogLinks`、Android `ListenerLibrary.mergeLinks`）时，对端已把本机记着的那个游戏改关联到本机另一个现存游戏，才移除本机的旧关联；对端的关联指向本机已删除的游戏时视为它还没更新的旧关联，本机关联保留，并在下一次交换时更新对端。

新增设备的默认名称使用对端声明：Windows `/v1/device` 默认返回系统计算机名称，Android catalog 优先读取系统设备名称，读取失败或空值时使用型号，名称限 128 个 UTF-16 码元且截断不拆开代理对。重新连接或目录表交换不覆盖已保存的名称。

添加或导入游戏时先选择本机目录，选定后才能确认并写入游戏配置；取消不添加游戏。目录设置显示 `displayPath`，添加游戏时游戏名默认取 `parentName`，缺省时用 `displayName`；从另一端导入时默认填另一端的游戏名，选目录不改名称。选择目录即为写入授权，界面没有单独的“允许接收”和“撤销接收授权”入口。Android 使用系统选择器保存持久 READ/WRITE 权限，每次写入前由 `SyncWriter` 重新核实；Windows 根据已保存的本机游戏目录，在写入前检查 rootId、目录身份与写权限。进程重启后继续使用已配置目录，权限失效时重新选择；只恢复目录写入授权，不恢复旧传输任务。

主动握手后的首个 catalog 请求携带 `x-sync-connect: 1`，之后的交换不携带。监听方断开只修改进程内会话并以 4001 关闭控制连接，不写入 `blocked=true`；断开后的普通交换收到 `session-mismatch`，拨号方再次主动连接时清除标记。连接失败返回 HTTP 状态、协议码及原生 errno 或异常类型，不附加原因改写或重试建议。

界面由 `apps/desktop/src/renderer/src` 和 `apps/mobile/src` 各自维护，平台接入位于各端 `platform/library-adapter.ts`。`apps/shared` 提供协议、配置、任务数据、传输预检与游戏关联规则，不依赖组件库或平台 API。双端都有复制计划/结果、备份设置/列表和本机恢复，也都能发起复制和选择删除目标多出的条目。

## 8. 发现与连接二维码

格式在 `apps/shared/src/connection`，字段和函数见 [共享包](shared-package.md#9-发现与连接二维码)。两种格式都由监听方提供、拨号方读取，不按平台区分；扫码只在移动端提供。拿到的地址只用来连接，连接后仍用 `/v1/device` 核对设备 ID，设备 ID 不一致时不替换已保存的设备。

- DNS-SD：服务类型 `_savedata-sync._tcp`，实例名是截到 63 个 UTF-8 字节的显示名，TXT 为 `v`、`id`、`pf`。地址和端口取 SRV 与 A 记录，拨号方只用 IPv4。
- 二维码：`savedata-sync://connect?v=1&id=<设备 ID>&p=<端口>&a=<IPv4>,…`，1–8 个地址按推荐顺序排列，拨号方依次尝试。两端设备页在本机服务运行时显示，载荷取服务快照的 `deviceId`、实际端口和 `listener.ipv4Addresses`；没有地址时不显示二维码。虚拟机、Hyper-V、代理软件的虚拟网卡不进二维码：其他设备访问不到，列出来会暴露本机内部网络，扫码端还会去连它所在网络里碰巧同址的主机。
- 电脑端广播：HTTP 服务监听期间由 sidecar 广播，TXT 的 `pf` 在 Linux 上为 `linux`，其余为 `windows`；停止服务或退出应用时发 goodbye 包。SRV 主机名是 `savedata-sync-<设备 ID>`（小写，`_` 换成 `-`），不用显示名；只发 A 记录，每块网卡只回答这块网卡的地址。实例名重名时自动加序号。广播失败时 HTTP 服务照常运行，服务快照的 `discovery` 显示失败并每 30 秒重试；防火墙拦截 UDP 5353 时本机察觉不到。实现见 [电脑端平台层](desktop.md#6-界面通道与服务控制)。
- Android 广播：本机服务运行期间用 NsdManager 注册，TXT 的 `pf` 为 `android`，注册失败 30 秒后重试，停止服务时注销；二维码地址优先 Wi-Fi 和以太网，再是热点，不含移动网络和 VPN。实现见 [Android 平台层](android.md#14-本机服务监听方)。
- Android 搜索：只在有页面订阅时用 NsdManager 搜索，Activity 停止时暂停；结果只含 IPv4 地址和探测 `/v1/device` 回 200 的服务，TXT 由 `parseDiscoveryTxt` 校验后按设备 ID 合并，协议版本不同的只保留实例名。接口见[Android 平台层](android.md#12-局域网设备搜索)。
- 版本：两种格式的 `v` 都是 `PROTOCOL_VERSION`。版本不同时解析结果为 `unsupported-version`，其余字段不解析；不合法时为 `invalid`。
