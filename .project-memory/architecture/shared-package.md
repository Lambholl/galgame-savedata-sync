---
doc_type: architecture
status: active
updated: 2026-11-22
tags: [共享包, 数据模型, 守卫]
---

# 共享包

## 目录

- [1. 范围与兼容性](#1-范围与兼容性)
- [2. 本地目录与设备模型](#2-本地目录与设备模型)
- [3. 守卫](#3-守卫)
- [4. HTTP 线格式与预算](#4-http-线格式与预算)
- [5. 资源及跨语言责任](#5-资源及跨语言责任)
- [6. 检查与验证边界](#6-检查与验证边界)
- [7. 游戏关联与项目绑定](#7-游戏关联与项目绑定)
- [8. 当前扫描与覆盖计划](#8-当前扫描与覆盖计划)
- [9. 发现与连接二维码](#9-发现与连接二维码)

## 1. 范围与兼容性

`@savedata-sync/shared` 位于 `apps/shared`，从 `src/index.ts` 导出应用名、协议 v1 的本地目录/设备 DTO、设备描述与固定上限、纯数据守卫、协议常量、游戏关联、复制计划与任务数据、控制通道和连接格式。IO、归档编解码、HTTP 服务/客户端、任务存储和实际文件同步分别在各平台模块中。

`@savedata-sync/shared/ui`（`src/ui`）放两端共用的 React 展示组件，例如 PathText；它可以依赖 React、`@ant-design/icons` 与不涉及平台交互的 antd 组件，主入口不得导入它，因此电脑端 sidecar 和 node 测试不会加载 React。组件参数逐项声明，不接受样式参数，规则见 [ADR-0002](../decisions/ADR-0002-ui-library-and-shared-rendering.md) 与 `eslint.config.mjs`。

设备描述、发现 TXT 和连接二维码使用数字 `PROTOCOL_VERSION=3`。本地目录桥使用 DeviceDescriptor、DirectoryReference、EntryMetadata、DirectoryListing 和 DirectorySelectionResult；HTTP 的 DeviceResponse 为 `OperationResult<BatchDeviceDescriptor>`，包装本地 device 并提供 sessionId/limits。应用仍是测试版，协议字段可以不兼容地修改，但两端必须同时更新。

设备接口和归档格式见[设备接口与归档格式](transfer-protocol.md)；共享包负责数据与关系约束，Windows 私有归档、HTTP 服务、受保护写入、Java 归档及 Android 原生网络都在平台层实现。

## 2. 本地目录与设备模型

| 对象 | 语义与约束 |
| --- | --- |
| 本地设备/目录 | 安装内 deviceId 与连接地址分离；授权 granted/expired/unavailable/unverified；URI 与真实路径留在平台内部；选择取消不清除原目录 |
| 元数据/当前层 | file/directory 联合；目录 sizeBytes 固定 null，文件未知为 null、空文件为 0；时间为 Unix 毫秒（±8.64e15 内安全整数），0 和负数有效；只列当前层，不汇总目录大小 |
| 基本数据 | ID 为 1–128 位 URL 安全 ASCII；SHA-256 为 64 位小写十六进制；展示文本非空白、最多 1024 个 UTF-16 码元且不含未配对代理项；无类型强制转换 |
| 共同创建名 | 最多 255 个 UTF-16 码元；拒绝路径、控制字符、Windows 保留名及尾部点/空格；保留合法 Unicode，不归一化/改名；实际名称竞争仍由平台验证 |
| BatchDeviceDescriptor / BatchLimits | `GET /v1/device` 的返回值：device、sessionId 和固定 limits；limits 必须与 `BATCH_LIMITS` 完全相同 |

## 3. 守卫

`is…` 守卫接收已解析 JSON/plain data，执行只读校验，不处理 IO、哈希或归档。非普通容器、稀疏数组、缺失/额外字段、非法联合或超范围值返回 false。可执行 getter/Proxy 需要解析层先行拒绝；解析层还负责重复 JSON 键、非法 UTF-8、超限文本和歧义 HTTP 定界。

本地守卫为 isDeviceDescriptor、isDirectoryReference、isEntryReference、isEntryMetadata、isDirectoryListing、isOperationError、isOperationResult 和 isDirectorySelectionResult。设备描述守卫为 isBatchLimits 和 isBatchDeviceDescriptor。isBatchFileId/isOpaqueId/isSha256/isPortableFileName/isProtocolVersionSupported 为纯值辅助守卫。复制计划、任务状态和结果的守卫见第 8 节。

结构/关系校验只检查数据；权限、文件身份、名称等价和回读内容由平台层执行。读取配置中的 deviceId 与当前连接返回的 deviceId/sessionId 也由调用者核实。

## 4. HTTP 线格式与预算

路由、头和数据声明由共享包导出，Windows HTTP 服务和 Android 原生 HTTP 客户端按它们实现。除 GET /v1/device 外，请求均须唯一 `x-sync-session-id`（`HTTP_HEADERS.sessionId`）；sessionId 每次服务启动都会变化，设备身份用 deviceId，认证不在这层。

| 路由 | 方法与输入 | 成功响应 |
| --- | --- | --- |
| /v1/device | GET | 200，DeviceResponse，值为 device/sessionId/limits |
| /v1/roots | GET | 200，RootsResponse，只返回本机已选择根 |
| /v1/roots/{rootId}/entries | GET；可选 parentId 查询参数，省略为 null | 200，DirectoryResponse，当前层清单 |

`/v1/catalog`（`HTTP_ROUTES.catalog`）、`/v1/control` 和 `/v1/sync/*` 的格式在 `src/library`、`src/control` 和 `src/sync`，见[接口约定](api-contracts.md)和[复制、备份与恢复约定](sync-copy.md)。拨号方新建连接时的目录表交换带 `x-sync-connect: 1`（`HTTP_HEADERS.connect`）；控制通道的自定义关闭码是 `CONTROL_CLOSE_CODES`，游戏库配置和目录表的数量与名称长度上限是 `LIBRARY_LIMITS`。Android 原生不能导入共享包，对应常量写在 `ListenerControl`、`ListenerLibrary` 等类里，注释注明与哪个共享常量相同，改值时一起改。JSON 使用 OperationResult 互斥包络。复制内容按单次完整 gzip 传输，不设 Content-Encoding，也不提供解压、重定向、Range、续传或自动重放。目录 parentId 按查询参数规则解码一次。

`BATCH_LIMITS` 固定最多 1024 文件、单文件 256 MiB、原文合计 1 GiB、tar 1 GiB+1 MiB、电脑接收的压缩体 1088 MiB、单个 JSON 8 MiB、每端一个活动任务、每会话 4096 个已接纳任务 ID。`BATCH_RESOURCES` 为 64 KiB 显式 IO 缓冲和 3 GiB 私有缓存；`BATCH_TIMEOUTS_MS` 为发送端 ready 等待 10 分钟、等内容 2 分钟、总期限 30 分钟、网络无进展 60 秒、终态保留 10 分钟。这里只提供常量，计时/限流/缓存/ID 生命周期由平台实现。

`BATCH_ARCHIVE` 固定受限 USTAR、gzip level 1 和 application/gzip；成员名仅 fileId。tar 头、填充、结束、gzip 单 member/CRC/ISIZE 由原生编解码器检查。当前预算按首轮实现设定，产品规模和峰值内存还没实测。

HTTP_ERROR_STATUS 映射错误码到 HTTP 状态，包括 session-mismatch/task-conflict/plan-expired=409、invalid-archive=422、resource-limit=413、busy=429、timeout=408；network-failure 和 port-unavailable 的 HTTP 状态为 null；port-unavailable 只在本机服务监听失败时出现，不经 HTTP 发给对端。io-failure 表示文件、目录或本机存储读写失败；桥收到和请求对不上的返回值、IPC 或原生服务不可用、配置数据损坏、任务没写入终态就结束这类程序内部问题报 internal-error（HTTP 500）。文件访问的异常映射（Android `ArchiveFailure.from`、`DirectoryFailure.from`，电脑 archive、directory、publication 的错误映射）把认不出的异常仍记为 io-failure，因为文档提供方和文件系统在文件不可访问时也会抛运行时异常；电脑 `toHttpError` 只把带 `syscall` 的 Node 系统错误记为 io-failure，其余记为 internal-error。session-mismatch 和 result-unknown 均禁止 canRetry=true；其他 canRetry 也只允许核实当前状态后由用户新建操作。

## 5. 资源及跨语言责任

- 原生层拥有流、压缩器、缓存、任务、回调和监听；向 JS 仅传 JSON 快照，不传文件内容、Base64、句柄或 URI。Android 使用 Java，long 输出前检查 JS 安全整数范围。
- 发送端按复制计划边读边打包，接收端边收边解包到私有缓存，通过校验后才写入目标。计划、指纹和结果只在当前会话短期存活，没有历史基线。
- Windows 私有归档、源变化检查及严格 JSON/HTTP 读取见 [Windows 平台层](windows.md)；Java 归档、SAF 写入及 Android 原生网络见 [Android 平台层](android.md)。共同创建名统一名称规则，Windows 竞争检查和 SAF 提供者检查分别执行。
- Android 用户发起复制后，由 dataSync 前台服务和持续通知保持；切后台或 Activity 重建不会取消已有任务。传输生命周期和平台中断由各端原生层管理。

## 6. 检查与验证边界

- `pnpm test` 包含本包的最小运行时测试，覆盖本地模型、设备描述、复制计划和任务数据关系，使用 Node 内置测试器和类型擦除。
- `pnpm typecheck` 执行严格类型检查；类型约束直接由编译器验证，不维护预期失败反例。本包使用 ES2022 标准库，并关闭平台类型自动注入。

超限 JSON、重复键、非法归档字节、真实 IO、网络、SAF 写入和前台中断由平台层验证。

## 7. 游戏关联与项目绑定

withGameLink、withoutGameLink、createImportedGame 返回新的游戏配置，由各端保存。两端保存游戏时，只用 `changedGameRootIds` 列出的、新设或换了根目录的 rootId 核对是否已登记；根目录没变的游戏引用着不存在的目录（如目录登记被重置后）不挡保存，界面里显示为要重新选择目录。unwrap 将 OperationResult 的失败转换为带 code 的 OperationFailure，toShownError 转为界面显示的错误。

`resolveSyncProjectBinding(config, roots, peer, projectId)` 从本机游戏配置、已登记目录和当前对端目录表取得固定项目/设备/目录 ID，离线、失效授权或错位设备返回具体错误。`matchesSyncProjectBinding` 用于异步权限确认后复核映射；设备显示名与 IP 改动不改变关联身份。调用示例见移动端 `src/platform/library-adapter.ts`。

## 8. 当前扫描与覆盖计划

`src/sync/` 提供独立 `SYNC_SCHEMA_VERSION=1` 的当前快照、覆盖计划、备份清单/设置和逐项发布结果，完整规则和预算见[复制、备份与恢复约定](sync-copy.md)。

`isSyncSnapshot` 校验封闭字段、实测文件属性、目录大小恒为 null、路径/ID 唯一性和父目录链。扫描失败可以带部分条目供说明，规划仍会阻止执行。路径使用原始名称段，`isSyncPath` 检查结构和长度，计划器另检查可移植创建名及保守的名称等价冲突。

`SyncScanRequest` 只含 schemaVersion/rootId，`isSyncScanState` 核对扫描句柄、状态、成功快照的实测字节数和完整指纹；失败可保留部分条目，取消与空目录成功分开。`isSyncCapabilities` 校验能力声明与固定扫描限制。

`createSyncPlan({ planId, projectId, operation, direction, shouldBackup, shouldDeleteExtras, source, target })` 生成本次计划。`operation=copy` 使用明确的跨端方向（`listener-to-dialer`、`dialer-to-listener`，见 [ADR-0004](../decisions/ADR-0004-symmetric-listener-dialer-roles.md)）；`operation=restore` 使用 `local-restore`、同一设备、开启的保护备份和 `shouldDeleteExtras=false`。`shouldDeleteExtras=true` 时目标多出的条目变成 `delete-file`/`delete-directory`，排在所有写入之后，由深到浅；`withDeleteExtras(plan, value)` 用同一批快照重算，切换开关时不需要重新扫描。源/目标是本次 `SyncSnapshot`，恢复源由本机已验证备份构造。非法输入抛 Error；读取错误、内容未知、类型/名称冲突和超限返回 `canExecute=false` 及问题列表。

计划器复制输入快照，按固定路径顺序给出操作，父目录先创建；不会修改输入、执行 IO、按时间选方向或查询历史。待传字节统计本次写入文件；备份开启且有写入时，备份字节统计目标目录的全部文件，包括未变化和仅存在于目标的文件，并校验文件数、单文件大小和总大小。`selectSyncBackupFiles(plan)` 返回这个集合；备份关闭、无写入或目标没有文件时返回空集合。未知或无法表示为安全整数的字节数为 null。`isSyncPlan` 重新推导完整计划；执行前用 `matchesSyncPlan(value, input)` 对照调用方保存的本次上下文，不能只校验 planId 或 canExecute。

`isSyncBackupManifest` 检查独立备份格式、连续 fileId、文件指纹、路径关系和预算；`isSyncBackupSettings` 检查项目/rootId 设置唯一性，没有设置文件时两端都用全局关闭的默认设置（`EMPTY_BACKUP_SETTINGS`，Android 是 `BackupModel.emptySettings`）。备份列表只用于恢复，比较器不读取备份。

`isSyncApplyResult` 校验逐项结果、备份 ID 和独立清理错误。`matchesSyncApplyResult(result, plan)` 核对完整写入集合、顺序、成功项长度/哈希及默认保护；失败/取消后只允许未执行项。目录成功不携带文件字节，未知结果必须使用 result-unknown。权限、实际内容、备份有效性、会话期限、资源释放和真实写入仍由平台模块处理。

`SyncJobRequest` 固定两端项目及完整计划；`matchesSyncJobManifest` 核对源引用、原名/父目录/日期和指纹，`matchesSyncJobState` 核对角色、计数及完整实际结果。Windows 源 preparing 完成后以 ready 等待单次内容 GET，零文件计划不提交归档。`SyncPreparationPreview` 的 `localSide` 标明本机是监听方还是拨号方，`isPreviewLocalSource` 据此和方向判断本机是否是发送端；`syncPlanFromPreview` 生成同一份计划，plan.projectId 使用目标端的项目 ID；`SyncTransferState` 分别保存本机及远端状态，sender sent 不表示 receiver 成功。`SyncJobDigest` 是 `SyncJobState` 去掉逐项结果的有界摘要，由 `isSyncJobDigest` 和 `matchesSyncJobDigest` 校验；`observeSyncJob(local, remote, hasRemoteError)` 把两个角色合成总体状态、阶段、当前段百分比、失败阶段和计数，两端的详情、横条、历史和提示都读它。准备、任务、清单和结果分开查询，协议统一见[复制、备份与恢复约定](sync-copy.md)。

## 9. 发现与连接二维码

`src/connection` 定义拨号方找到监听方用的两种格式，按监听方和拨号方区分，不按平台区分。两种格式都只用来拿到地址，连接后仍以 `/v1/device` 返回的设备 ID 为准。

| 格式 | 内容 | 函数 |
| --- | --- | --- |
| DNS-SD 服务 | 服务类型 `_savedata-sync._tcp`（`DISCOVERY_SERVICE`）。实例名是显示名，按码位截到 63 个 UTF-8 字节，重名时由系统加后缀，只用于显示。TXT 为 `v`（协议版本）、`id`（设备 ID）、`pf`（`windows` 或 `android`），端口和地址取 SRV 与 A 记录 | `createDiscoveryInstanceName`、`createDiscoveryTxt`、`parseDiscoveryTxt` |
| 连接二维码 | `savedata-sync://connect?v=1&id=<设备 ID>&p=<端口>&a=<IPv4>,<IPv4>`，地址 1–8 个、按推荐顺序、不重复。监听方显示，只有移动端扫码 | `createConnectionQrText`、`parseConnectionQrText` |
| 候选地址 | 把 IPv4 列表和端口转成依次尝试的 `http://ip:port`，保留顺序，跳过非 IPv4 和重复项 | `createConnectionCandidates`、`isIpv4Address`、`isListeningPort` |

解析函数返回 `valid`、`unsupported-version` 或 `invalid`。版本字段先于其他字段检查，版本不同时其余字段不解析，发现列表和扫码页可以提示对端需要更新。二维码字段名和前缀区分大小写，字段必须恰好是 `v`、`id`、`p`、`a`；TXT 按 RFC 6763 不区分键名大小写、忽略未知字段，同一个键出现多次时拒绝。生成函数遇到不合法的设备 ID、端口或地址时抛出 `invalid-request`。
