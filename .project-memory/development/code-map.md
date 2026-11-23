---
doc_type: code-map
status: active
updated: 2026-11-23
tags: [代码地图]
---

# 代码地图

## 目录

- [1. 根目录与工具](#1-根目录与工具)
- [2. 共享包](#2-共享包)
- [3. 电脑端](#3-电脑端)
- [4. 移动端网页层](#4-移动端网页层)
- [5. Android 原生](#5-android-原生)

“重要约定”只写改这个路径时不能破坏的边界。测试和检查的运行范围见[测试规范](../standards/testing.md)。

## 1. 根目录与工具

| 路径 | 作用 | 重要约定 |
| --- | --- | --- |
| `package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml` | pnpm 工作区、固定版本与工程入口 | 私有工作区；使用指定 pnpm，不依赖系统全局 Gradle |
| `README.md`、`docs/development.md` | 用户说明；开发命令、工具要求与检查范围 | 版本约束以工程配置为准 |
| `scripts/doctor.mjs`、`scripts/local-environment.mjs` | 开发工具入口 | 使用方式见 `docs/development.md` |
| `scripts/check-text.mjs`、`eslint.config.mjs`、`tsconfig.base.json` | 编码、格式、lint 和严格类型检查 | 生成目录不作为手写代码格式化 |
| `scripts/android-build.mjs`、`scripts/android-open.mjs` | 原生构建、单元/lint/双 APK 检查、依赖清单与 IDE 入口 | 不连接设备；只对子进程传入 SDK/JDK；IDE 不存在时明确失败；Windows 以 `.\gradlew.bat` 显式相对路径调用 Wrapper，兼容设置了 NoDefaultCurrentDirectoryInExePath 的 shell |
| `scripts/verify-archive-interop.mjs` | 构建前 Windows 准备、构建后 Windows 接收 Java 输出，另支持设备产物及 SAF 原文验证 | 只操作固定报告目录中的合成数据，测试 APK 不包含主机路径配置 |
| `scripts/security-check.mjs`、`scripts/toolchain-policy.mjs` | npm 全量审计、pnpm 公告与 Node 安全补丁门禁 | 查询失败即失败；安全基线来自已核实的官方发行记录 |
| `scripts/android-inventory.gradle`、`scripts/security-android.mjs` | 解析 Maven 实际依赖并查询 OSV | 含运行、测试和构建图；未解析依赖导致失败；临时报告在 .reports/ |
| `.github/workflows/ci.yml` | Windows 工程检查（含 Clippy 和 rustfmt）与 Android 构建 CI | Action 固定 commit SHA；Rust 编译缓存用 rust-cache；只处理分支 push 与 PR，tag 交给发布流程 |
| `.github/workflows/release.yml`、`scripts/app-version.mjs` | `vX.Y.Z` tag 的版本推算、完整测试、Windows 安装包和免安装 zip、APK 构建、SHA-256、artifact 和草稿 Release | 版本只来自 Git tag，`app-version.mjs` 供两端 Vite 配置（注入共享包 `APP_VERSION`）、Windows 打包和 Android `build.gradle` 共用；tag 必须指向当前提交且在 `origin/master` 上；Rust 不用编译缓存；Release 说明在 GitHub 页面补充，不进 Git |

## 2. 共享包

| 路径 | 作用 | 重要约定 |
| --- | --- | --- |
| `apps/shared/src/index.ts`、`library/game-links.ts`、`transfer`、`result.ts` | 应用名、共享模型、游戏关联、传输预检和任务判断导出入口 | 纯 TypeScript；界面、Hook、存储、文件与网络操作留在各端 |
| `apps/shared/src/protocol/contracts.ts`、`protocol.ts`、`validation.ts` | 协议版本、DTO、错误/路由/头名映射与纯数据守卫 | 封闭 DTO 区分空值、失败和未知结果；平台路径、权限和真实内容校验由适配器负责 |
| `apps/shared/src/protocol/batch-contracts.ts`、`batch-limits.ts`、`batch-validation.ts`；`src/validation/data-validation.ts` | 设备描述和固定上限 DTO、预算/期限/归档常量及守卫；基础容器/文本/数值辅助供内部复用 | 上限固定，两端相同；不含归档、HTTP、IO 或历史存储 |
| `apps/shared/src/sync/` | 本次扫描/计划/备份/结果 DTO、路径关系、纯比较及上下文重算守卫 | 独立 schema 1；不做 IO、哈希计算或历史查询；复制方向显式，本机恢复强制保护当前内容 |
| `apps/shared/src/control`；Windows `backend/control-hub.ts`、`backend/dialer-control.ts`；Java `ControlClient.java`、`TransferEngine.java` 控制部分；移动 `platform/control-channel.ts`、`features/transfer/use-remote-sync.ts` | WebSocket 控制通道 `/v1/control`：目录读取、电脑发起复制、完成回报、目录表变化通知和在线判断 | 消息格式对称，按监听方和拨号方区分；HTTP 服务核实身份后才升级；两端严格校验每条消息；文件内容不走控制通道 |
| `apps/shared/src/poster/`、`test/poster-search.test.mjs` | 封面搜索：四个来源的请求生成与响应解析、按来源限流、错误码、接口和图片主机白名单 | 只生成请求和解析响应，HTTP 由各端执行器完成；执行器在请求前用 `isPosterRequestAllowed`、`isPosterImageUrl` 检查地址，Android 原生不能导入共享包，白名单和上限要在 Java 里写同样的值。接口事实见[游戏封面](../architecture/poster.md) |
| `apps/shared/src/connection` | DNS-SD 服务类型、实例名和 TXT，连接二维码文本，候选连接地址 | 监听方生成、拨号方解析，不按平台区分；解析结果分 valid、unsupported-version、invalid，版本先于其他字段检查；地址只用于连接，身份以 `/v1/device` 为准 |
| `apps/shared/src/ui/navigation/page-navigation.ts`、`use-page-navigation.ts` | 两端共用的页面导航：前者是来源记录、返回目标和切页方向的纯函数，后者把它接到 React 状态 | 页面名称和上下文由各端定义；跳转关系写在 DesktopApp、MobileApp |
| `apps/shared/test/` | 运行时数据关系回归；字段和线格式见[共享包](../architecture/shared-package.md) | — |

## 3. 电脑端

| 路径 | 作用 | 重要约定 |
| --- | --- | --- |
| `apps/desktop/` | Tauri 宿主 `src-tauri`、后端 `src/backend`、sidecar 入口 `src/sidecar`、bridge `src/bridge` 和独立 antd 界面 `src/renderer` | 界面只能调用 `backend_invoke`，由宿主转给 sidecar |
| `apps/desktop/src-tauri/src/main.rs`、`sidecar.rs`、`storage.rs`、`capabilities/main.json`、`tauri.conf.json` | 宿主：窗口、单实例、`backend_invoke` 命令、sidecar 进程和消息、平台能力（目录选择器、打开文件夹、明暗）、存储目录和便携模式 | `sidecar.rs` 的消息类型和 `src/sidecar/protocol.ts` 一起改；capability 只授权 `main` 窗口调用 `backend_invoke`；`cargo test` 覆盖消息解析 |
| `apps/desktop/scripts/package-windows.mjs`、`build-sidecar-exe.mjs` | Windows 打包：sidecar 用 `@yao-pkg/pkg` 编成独立可执行文件，`tauri build` 产出 NSIS 安装包，再打免安装 zip | 只在 Windows x64 上运行；`bundle.externalBin` 只在打包时通过 `--config` 登记，见 [Windows 平台层](../architecture/windows.md#3-分发包与应用标识) |
| `apps/desktop/src/backend/backend.ts`、`channel-registry.ts` | `startBackend` 初始化配置、数据、备份库、缓存四个目录和各服务，登记全部界面通道，`stop` 按顺序释放；`ChannelRouter` 按通道名分发界面请求 | 后端是纯 Node 代码，平台能力（目录选择器、打开路径、明暗主题）经 `DesktopHost` 由宿主提供；能调用通道的页面由 Tauri capability 限定 |
| `apps/desktop/src/sidecar/index.ts`、`protocol.ts`、`vite.sidecar.config.ts` | sidecar 入口：从命令行读四个存储目录，stdin/stdout 按行 JSON 与宿主交换消息，构建为 `out/sidecar/index.cjs` | stdout 只写协议消息，`console.log` 改写到 stderr；stdin 关闭时停止服务后退出；第三方包全部打进产物 |
| `apps/desktop/src/renderer/src/app`、`features`、`components`、`styles`、`platform`、`vite.config.ts` | 独立桌面导航、居中弹窗、antd 页面及 bridge 接入；`platform/desktop-bridges.ts` 在 Tauri 窗口里安装各 `window.desktop*` 接口 | 两端源码互不导入；桌面传输页可请求移动端扫描并在电脑确认计划（TransferPage、backend/remote-sync-requests.ts），实际复制由移动端执行 |
| `apps/desktop/src/backend/directory-adapter.ts`、`directory-store.ts`、`device-identity.ts`、`directory-paths.ts`、`directory-errors.ts` | 目录选择登记、设备身份、当前层元数据、根内原生读流及脱敏错误 | 没有源目录写入 API；拒绝 symlink/junction 与失效身份；配置不保存历史文件索引 |
| `apps/desktop/src/bridge/directory-bridge.ts`、`src/backend/directory-ipc.ts` | 三个有限目录方法与通道参数、返回校验 | 绝对路径和文件内容不经界面通道 |
| `apps/desktop/src/backend/archive-adapter.ts`、`archive-cache.ts`、`archive-format.ts`、`archive-errors.ts`、`test/archive-adapter.test.mjs`、`test/fixtures/archive-v1.json` | 按计划边读边打包、边收边解包的受限 USTAR/gzip1 编解码、严格 gzip 头尾检查、资源/取消与缓存所有权/清理，及格式回归 | 不做 HTTP 或目标写入；缓存与源根互不包含；解包结果持有缓存，读流关闭后 dispose；清理失败阻止新任务；格式夹具和 Java 共用，两端各自往返不算互通证据 |
| `apps/desktop/src/backend/backup-store.ts`、`backup-files.ts`、`backup-location.ts`、`manual-backup-registry.ts`、`backup-ipc.ts`、`src/bridge/backup-bridge.ts`、`test/backup-store.test.mjs` | 用户可手动管理的持久备份、流式校验/提交、本机异步手动备份、按份数平级轮换、备份库位置、恢复材料和有限本机查询 | 写备份库（默认数据根下的 `backups`，用户可在设置页更换），设置在数据目录的 `backup-settings.json`；目录适配器排除备份库；手动备份与传输、恢复共用 `TargetOperation` 名额；原文读取和创建留在后端，恢复写回由 `sync-writer` 与 `restore-registry` 负责 |
| `apps/desktop/src/backend/http-service.ts`、`http-wire.ts`、`http-errors.ts`、`test/http-service.test.mjs` | 原生 HTTP 设备/目录读取、目录表交换、控制通道升级和 `/v1/sync/*` 路由，严格协议字节边界 | 显式监听且默认回环；复制任务由 `sync-registry.ts` 登记；应用退出等待 stop |
| `apps/desktop/src/bridge/service-bridge.ts`、`src/backend/service-ipc.ts`、`src/renderer/src/features/devices` | 本机服务启停、端口、目录选择、扫描桥与设备页控制 | 校验参数与 DTO；不传私有路径或字节 |
| `apps/desktop/src/backend/discovery-advertiser.ts` | 服务运行期间用 `@homebridge/ciao` 做 mDNS 广播，状态进服务快照的 `discovery` | 服务 IPC 启停时调用，退出前由 `backend.ts` 的 `stop` 停止；失败不影响 HTTP 服务，30 秒重试 |
| `apps/desktop/src/backend/dialer-session.ts`、`dialer-http.ts`、`dialer-control.ts` | 电脑作为拨号方连接另一台设备：交换目录表、读取对方目录、控制通道重连和断开 | 同一时间只连一台；连着时本机监听服务对新连接返回 `busy`；`library-store.ts` 经 `LibraryDialer` 把连着的设备并入设备快照和目录读取 |
| `apps/desktop/src/backend/dialer-sync.ts` | 电脑作为拨号方的复制：两端扫描、计划、任务登记、内容上传下载、取消、结果补读，处理对方经控制通道发起的 `sync.*` 请求 | 和监听方任务共用写入名额；准备和任务只在内存，结束后保留 10 分钟、各最多 32 份；`sync-ipc.ts` 按设备把请求分给它或监听方部分 |
| `apps/desktop/src/backend/discovery-browser.ts` | 用 `bonjour-service` 搜索附近设备，按设备 ID 合并地址，排除本机 | 只在设备页可见时搜索；连接已保存的设备时由 `dialer-session.ts` 按设备 ID 查找 5 秒 |
| `apps/desktop/src/bridge/dialer-bridge.ts`、`src/backend/dialer-ipc.ts`、`src/renderer/src/features/devices/AddDeviceDialog.tsx` | 拨号桥（状态、附近设备、连接、连接已保存设备）和手动输入地址的对话框 | 通道校验参数：地址 1～16 个且已规范化，设备 ID 为不透明 ID 或 null |
| `apps/desktop/src/backend/sync-scanner.ts`、HTTP sync 路由、service bridge/IPC | Windows 本次递归扫描（只列目录，取大小和修改日期）及会话内查询/取消 | 单扫描，最多保留 32 份结果，有条目、深度、JSON 和期限预算；只读源；取消或停止要等流关闭；结果不持久化 |
| `apps/desktop/src/backend/sync-writer.ts`、`sync-target-files.ts`、`target-operation.ts`、`publication-errors.ts`；directory-adapter、启动 | 确认计划的目标目录创建、同卷候选替换和本机恢复；接收远端内容时等内容收齐再写入；复制和恢复共用 `TargetOperation` 互斥 | 写入前备份目标目录全部文件，内容收齐后重新核对目标，逐项报告实际结果，首次失败停止；同路径对象替换产生新 ID；原生流和候选不跨桥 |
| `apps/desktop/src/backend/restore-registry.ts`、`sync-ipc.ts`、`src/bridge/sync-bridge.ts` | 进程内异步恢复、有限复制与恢复桥、同次原生计划/结果核对 | 普通准备不占目标名额，确认后借用并保留至清理成功；任务和结果可在页面刷新后查询；不接收路径或字节；电脑发起的方法转给 `remote-sync-requests.ts` |
| `apps/desktop/src/renderer/src/features/backup`、`features/transfer/SyncCopyDetails.tsx`、`use-sync-details.ts`、`platform/sync-adapter.ts` | 备份开关/列表、恢复预览与确认、复制计划/实际结果、普通本机重扫 | 复用原生计划和结果；发送完成和移动端实际写入是两个状态；切页只停止轮询，不取消原生任务 |
| `apps/desktop/test/` | Windows 目录、归档、HTTP、扫描、备份与写入的最小长期回归；接口见 [Windows 平台层](../architecture/windows.md) | 测试只用合成数据；真实目录只读验证，机器路径不提交 |

## 4. 移动端网页层

| 路径 | 作用 | 重要约定 |
| --- | --- | --- |
| `apps/mobile/src/app`、`features`、`components`、`styles` | 独立移动入口、导航、游戏卡片、底部弹层和 antd-mobile 页面 | 优先移动组件；使用桌面组件也保留触控区域，操作卡片至少 64px；系统返回由移动端协调 |
| `apps/mobile/src/features/transfer`、`src/platform` | 双端目录比较、手动连接、方向、计划和原生任务显示 | 当前层浏览；两列独立滚动，时间精确到分钟；业务不判断前后台，重载后查询同一原生传输任务；源文件内容不经过网页 |
| `apps/mobile/src/components/PageSlide.tsx`、`apps/mobile/src/app/press-feedback.ts` | 移动端的切页平移和按下遮罩 | 桌面端的交互效果写在 desktop.css；shared 的 pressable.css 只定义遮罩的形状 |
| `apps/mobile/src/platform/directory-bridge.ts`、`directories.ts`、`test/` | 受限 TS 桥、原生绑定与数据模型检查 | 网页预览不支持；只传公开 DTO/ID，没有内容或写入方法 |
| `apps/mobile/src/platform/local-service-bridge.ts`、`local-service.ts`、`features/devices/DevicesPage.tsx` | 本机服务桥（开关、端口、状态、连着本机的设备、目录读取和事件）与设备页的本机服务卡片 | 结果按共享格式校验；`library-adapter.ts` 把连着本机的设备并入快照，收到 `libraryChanged` 后重新读入配置 |
| `apps/mobile/src/platform/http-transfer-bridge.ts`、`http-transfers.ts` | 有限 TS 连接桥：连接、目录表交换、控制通道、远端目录浏览、通知权限和目录选择，以及原生返回值校验和事件订阅 | 浏览器不支持；通知和目标授权是显式动作；订阅 remove 不影响原生连接 |

## 5. Android 原生

Java 源码都在 `apps/mobile/android/app/src/main/java/io/github/galgame/savedatasync/`，下表只写文件名。

| 路径 | 作用 | 重要约定 |
| --- | --- | --- |
| `apps/mobile/android/` | Capacitor 生成的原生工程与项目 Wrapper | minSdk 30、compile/target 36；Manifest 允许明文 HTTP；包含用户发起传输使用的 dataSync 前台服务和本机服务使用的 connectedDevice 前台服务 |
| `apps/mobile/android/app/src/main/java/io/github/galgame/savedatasync/` | Java 目录选择（DirectoriesPlugin、DirectoryStore）、权限/配置恢复、当前层元数据和原生流 | URI 留在原生层，原生流由调用者关闭；配置不保存条目或哈希 |
| `DocumentAccess.java`、`SafDocumentAccess.java`、`FileDocumentAccess.java`；`AllFilesAccessPlugin.java`、移动 `platform/all-files-access.ts`、设置页 | 统一的目录访问接口及 SAF、按路径两种实现；所有文件访问权限状态与系统授权页入口 | 上层只经 `DirectoryStore.access(tree)` 取实现，见 ADR-0003 |
| `ArchiveAdapter.java`、`ArchiveModel.java`、`ArchiveFormat.java`、`ArchiveCache.java`、`ArchiveControl.java`、`ArchiveFailure.java`、`DirectoryArchiveSource.java`；`src/test/.../ArchiveAdapterTest.java`、`src/androidTest/.../ArchiveSafTest.java` | Java 边读边打包、边收边解包的严格 USTAR/单 gzip、固定预算/取消/期限与缓存归属/恢复/重试；SAF 读取前后复核；格式回归和设备往返 | 不做 JSON/HTTP/目标写入，文件内容不跨桥；`Staged` 关闭读流后 close；进程独占覆盖待清理资源；夹具与 Windows 共用；缺少实际目录授权时测试失败而不是跳过 |
| `NewFilePublisher.java`、`PublicationModel.java`、`DirectoryPublicationBackend.java`、`NewFilePublisherTest.java` | 原生显式写授权/只读预检、创建前后核实、非截断写入/回读、单文件结果及清理重试 | 只操作同根已有父目录中确知的新建条目；常规描述符身份保护已有文件；原文和 URI 不跨桥，清理失败保持进程名额；由 `SyncWriter` 创建目标里还没有的文件；接口见 [Android 平台层](../architecture/android.md) |
| `TransferJson/Schema/Http/Engine.java`、`HttpTransfersPlugin.java`、`TransferRuntime/Service.java`、`DirectoryRuntime.java` | 严格 HTTP/JSON、拨号方连接（目录表交换、控制通道、远端浏览）、复制任务的持续通知 | 文件不跨 JS；`TransferRuntime` 持有进程内唯一的 `TransferEngine`；服务不导出、不自动重启旧任务；只读桥和传输共享当前 SAF 引用 |
| `SyncScanner.java`、`DirectorySyncSource.java`、`SyncScansPlugin.java`；移动 `platform/sync-scan-bridge.ts`、`sync-scans.ts` | 本次递归扫描（取大小和修改日期，提供者不报大小时读一遍计数）、取消和有限扫描桥 | 普通只读操作，不加保活或前后台处理；结果只存内存并校验 rootId/scanId，内容和 URI 不跨桥 |
| `BackupStore/Model/Files.java`、`AndroidBackupIo.java`、`ManualBackupRuntime.java`、`SyncBackupsPlugin.java`；移动 `platform/backup-bridge.ts`、`backups.ts` | 用户可手动管理的持久备份、本机异步手动备份、按份数平级轮换、恢复材料引用和有限本机查询 | 写 `Android/data/<包名>/files/backups`，设置留在内部目录；`ManualBackupRuntime` 由 `DirectoryRuntime` 持有，Activity 销毁不中断，与传输和恢复共用 `TargetOperation` 名额；真实身份和链接数用 Os.lstat 检查；数据不跨桥；供 SyncWriter 复用 |
| `SyncPlanModel.java`、`SyncWriter.java`、`DirectorySyncBackend.java`、`SyncWriteRuntime.java`、`SyncWritesPlugin.java`、`TargetOperation.java`；移动 `platform/sync-write-bridge.ts`、`sync-writes.ts` | 确认计划的独立复核、SAF 目录创建/受保护覆盖与本机恢复、应用级任务及有限桥 | 整批复核和备份后写入，接收远端内容时等内容收齐并重新核对目标；常规 FD 身份/rw/最终长度，写后设来源的修改日期；复制和恢复共用 `TargetOperation` 互斥，恢复预览与结果各有查询入口；应用不判断前后台 |
| `SyncJobModel.java`、`SyncTransferEngine/Runtime.java`、`SyncTransfersPlugin.java`；移动 `platform/sync-transfer-bridge.ts`、`sync-transfers.ts`；Windows `main/sync-registry.ts`、`upload-body.ts` | 双向复制的普通扫描准备、同次确认、边打包边上传或边下载边解包、接收端与传输并行的备份、保护后写入及实际结果查询；`SyncTransferRuntime` 按对方设备把请求交给拨号方编排或本机服务的监听方任务 | 登记和内容各一次，回执丢失只查询；两端任务共用原生名额，只有实际传输保持通知，长源读取通过原生心跳确认通信；页面重建按 ID 查询，不恢复或重放 |
| `DeviceDiscoveryPlugin.java`、`DiscoveryBrowser.java`；移动 `platform/device-discovery.ts` | 局域网 DNS-SD 搜索：NsdManager 搜索与解析、按订阅者启停的 TS 桥，以及按设备 ID 限时查找的 `findDevice` | 原生只给实例名、端口、IPv4 和 TXT 文本，TXT 在 TS 用 shared 校验；状态在原生单个 worker 线程上 |
| `ListenerServer/Http/Socket/Control/Library.java`、`ListenerSyncJobs.java`、`ListenerSyncRequests.java`、`ListenerAdvertiser.java`、`ListenerRuntime.java`、`ListenerService.java`、`LocalServicePlugin.java`；`src/test/.../ListenerServerTest.java` | 本机服务（监听方）：HTTP/1.1 和 WebSocket 服务、控制通道监听端、目录表交换、`/v1/sync/*` 任务登记和内容收发、本机发起的传输经控制通道交给拨号方、NsdManager 广播、前台服务和网页接口 | 每条连接一个线程；同一时间一台设备在线，本机拨号时对新连接返回 busy；目录表交换在原生层写配置（经 `AppStoragePlugin` 的锁），Activity 销毁后仍能连接；接口见 [Android 平台层](../architecture/android.md#14-本机服务监听方) |
| `QrScannerPlugin.java`、`QrCameraSession.java`、`QrFrameDecoder.java`；移动 `platform/qr-scanner.ts`、`features/devices/ScanPage.tsx` | 扫码：相机权限、取景、逐帧识别二维码，扫到后交给 `connectCandidates` | 原生只给二维码原文，内容在 TS 用 shared 的 `parseConnectionQrText` 校验；相机绑定 Activity 生命周期，取景画面在透明的 WebView 下面，页面用 html 上的 `camera-live` 让出背景 |
| `apps/mobile/android/app/src/test/`、`src/androidTest/` | Java 纯边界与 3 条设备路径：目录读取、归档互通、实际目录快照 | 独立私有夹具与真实选择器授权；真实源只读 |
