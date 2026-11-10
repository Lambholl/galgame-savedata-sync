---
doc_type: code-map
status: active
updated: 2026-11-09
tags: [代码地图]
related_files: []
---

# 代码地图

## 目录

- [1. 根目录与工具](#1-根目录与工具)
- [2. 共享包](#2-共享包)
- [3. 电脑端](#3-电脑端)
- [4. 移动端网页层](#4-移动端网页层)
- [5. Android 原生](#5-android-原生)

“重要约定”只写改这个路径时不能破坏的边界。测试和检查的运行范围见[测试规范](../standards/testing-style.md)。

## 1. 根目录与工具

| 路径 | 作用 | 重要约定 |
| --- | --- | --- |
| `package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml` | pnpm 工作区、固定版本与工程入口 | 私有工作区；使用指定 pnpm，不依赖系统全局 Gradle |
| `README.md`、`docs/development.md` | 开发命令、工具要求与检查范围 | 版本约束以工程配置为准 |
| `scripts/doctor.mjs`、`scripts/local-environment.mjs` | 开发工具入口 | 使用方式见 README |
| `scripts/check-text.mjs`、`eslint.config.mjs`、`tsconfig.base.json` | 编码、格式、lint 和严格类型检查 | 生成目录不作为手写代码格式化 |
| `scripts/android-build.mjs`、`scripts/android-open.mjs` | 原生构建、单元/lint/双 APK 检查、依赖清单与 IDE 入口 | 不连接设备；只对子进程传入 SDK/JDK；IDE 不存在时明确失败；Windows 以 `.\gradlew.bat` 显式相对路径调用 Wrapper，兼容设置了 NoDefaultCurrentDirectoryInExePath 的 shell |
| `scripts/verify-archive-interop.mjs` | 构建前 Windows 准备、构建后 Windows 接收 Java 输出，另支持设备产物及 SAF 原文验证 | 只操作固定报告目录中的合成数据，测试 APK 不包含主机路径配置 |
| `scripts/security-check.mjs`、`scripts/toolchain-policy.mjs` | npm 全量审计、pnpm 公告与 Node 安全补丁门禁 | 查询失败即失败；安全基线来自已核实的官方发行记录 |
| `scripts/android-inventory.gradle`、`scripts/security-android.mjs` | 解析 Maven 实际依赖并查询 OSV | 含运行、测试和构建图；未解析依赖导致失败；临时报告在 .reports/ |
| `.github/workflows/ci.yml` | Windows 工程检查与 Android 构建 CI | Action 固定 commit SHA；只处理分支 push 与 PR，tag 交给发布流程 |
| `.github/workflows/release.yml`、`scripts/app-version.mjs` | `vX.Y.Z` tag 的版本推算、完整测试、Portable/APK 构建、SHA-256、artifact 和草稿 Release | 版本只来自 Git tag，`app-version.mjs` 供两端 Vite 配置（注入共享包 `APP_VERSION`）、`package-windows.mjs` 和 Android `build.gradle` 共用；tag 必须指向当前提交且在 `origin/main` 上；只构建 Portable，不构建 NSIS；Release 说明在 GitHub 页面补充，不进 Git |

## 2. 共享包

| 路径 | 作用 | 重要约定 |
| --- | --- | --- |
| `apps/shared/src/index.ts`、`library/game-links.ts`、`transfer`、`result.ts` | 应用名、共享模型、游戏关联、传输预检和任务判断导出入口 | 纯 TypeScript；界面、Hook、存储、文件与网络操作留在各端 |
| `apps/shared/src/protocol/contracts.ts`、`protocol.ts`、`validation.ts` | 协议版本 1 DTO、错误/路由/头名映射与纯数据守卫 | 封闭 DTO 区分空值、失败和未知结果；平台路径、权限和真实内容校验由适配器负责 |
| `apps/shared/src/protocol/batch-contracts.ts`、`batch-limits.ts`、`batch-validation.ts`、`batch-context.ts`、`data-validation.ts` | v1 批量 DTO、固定预算/期限、结构/关系守卫与任务上下文匹配；基础容器/文本/数值辅助供内部复用 | sender/receiver 分开；清单与目标一一对应；matchesBatchState 核对实际结果；不含归档、HTTP、IO 或历史存储 |
| `apps/shared/src/sync/` | 本次扫描/计划/备份/结果 DTO、路径关系、纯比较及上下文重算守卫 | 独立 schema 1，不改批量 v1；不做 IO、哈希计算或历史查询；复制方向显式，本机恢复强制保护当前内容 |
| `apps/shared/src/control`；Windows `main/control-hub.ts`；Java `ControlClient.java`、`TransferEngine.java` 控制部分；移动 `platform/control-channel.ts`、`features/transfer/use-remote-sync.ts` | WebSocket 控制通道 `/v1/control`：目录读取、电脑发起复制、完成回报、目录表变化通知和在线判断 | 消息格式对称，按监听方和拨号方区分；HTTP 服务核实身份后才升级；两端严格校验每条消息；文件内容不走控制通道 |
| `apps/shared/src/connection` | DNS-SD 服务类型、实例名和 TXT，连接二维码文本，候选连接地址 | 监听方生成、拨号方解析，不按平台区分；解析结果分 valid、unsupported-version、invalid，版本先于其他字段检查；地址只用于连接，身份以 `/v1/device` 为准 |
| `apps/shared/src/ui/navigation/page-navigation.ts`、`use-page-navigation.ts` | 两端共用的页面导航：前者是来源记录、返回目标和切页方向的纯函数，后者把它接到 React 状态 | 页面名称和上下文由各端定义；跳转关系写在 DesktopApp、MobileApp |
| `apps/shared/test/`、`apps/shared/README.md` | 运行时数据关系回归、完整线格式与调用示例 | — |

## 3. 电脑端

| 路径 | 作用 | 重要约定 |
| --- | --- | --- |
| `apps/desktop/` | Electron 主进程、preload 和独立 antd 界面 | Renderer 无 Node 集成；contextIsolation 和 sandbox 开启 |
| `apps/desktop/src/renderer/src/app`、`features`、`components`、`styles`、`platform` | 独立桌面导航、居中弹窗、antd 页面及有限桥接入 | 两端源码互不导入；桌面传输页可请求移动端扫描并在电脑确认计划（TransferPage、main/remote-sync-requests.ts），实际复制由移动端执行 |
| `apps/desktop/src/main/directory-adapter.ts`、`directory-store.ts`、`directory-paths.ts`、`directory-errors.ts` | 目录选择登记、独立配置、当前层元数据、根内原生读流及脱敏错误 | 没有源目录写入 API；拒绝 symlink/junction 与失效身份；配置不保存历史文件索引 |
| `apps/desktop/src/bridge/directory-bridge.ts`、`src/main/directory-ipc.ts`、`src/preload/index.ts` | 三个有限目录方法与 IPC 来源/参数/返回校验 | 绝对路径和文件内容不跨桥；handler 在退出时移除；main/preload 内联共享包 |
| `apps/desktop/src/main/archive-adapter.ts`、`archive-cache.ts`、`archive-format.ts`、`archive-errors.ts`、`test/archive-adapter.test.mjs`、`test/fixtures/archive-v1.json` | 私有源快照、受限 USTAR/gzip1 编解码、逐层校验、资源/取消与缓存所有权/清理，及格式回归 | 不做 HTTP 或目标发布；缓存与源根互不包含；句柄持有缓存，读流关闭后 dispose；清理失败阻止新任务；格式夹具和 Java 共用，两端各自往返不算互通证据 |
| `apps/desktop/src/main/backup-store.ts`、`backup-files.ts`、`backup-ipc.ts`、`src/bridge/backup-bridge.ts` | 用户可手动管理的持久备份、流式校验/提交、按份数轮换、恢复材料和有限本机查询 | 写 `userData/backups`，设置在 `userData/backup-settings.json`；目录适配器排除备份区；原文读取和创建留在主进程，恢复写回由 `sync-writer` 与 `restore-registry` 负责 |
| `apps/desktop/src/main/new-file-publisher.ts`、`publication-errors.ts`、`test/new-file-publisher.test.mjs` | 进程内写授权/预检、单文件候选/link/最终回读、逐项结果与清理重试 | 仅原生调用，目录/HTTP/UI 不自动授予写权限；候选与目标同卷，不覆盖或删除已有条目；崩溃后不猜测候选所有权 |
| `apps/desktop/src/main/http-service.ts`、`http-wire.ts`、`http-errors.ts`、`transfer-registry.ts`、`test/http-service.test.mjs` | 原生 HTTP 读取/接收、严格协议字节边界、会话内双角色任务/查询/取消、期限与单次 ID/content | 显式监听且默认回环；进程只有一个活动批次，清理失败不释放；sender sent 与目标发布分开，目标结果看 receiver；应用退出等待 stop |
| `apps/desktop/src/main/upload-receiver.ts`、`test/http-receiver.test.mjs` | 单次上传背压/断流/取消、压缩体检查点与异步完整归档校验、顺序发布/部分结果与上下文核对 | 接收适配和本机写授权是两道检查，全部原文验证前零发布；202 时发布结果另行查询；清理失败保留名额，响应或结果丢失不重放 |
| `apps/desktop/src/bridge/service-bridge.ts`、`src/main/service-ipc.ts`、`src/renderer/src/features/devices` | 本机服务启停/接收根授权/任务桥与设备页控制 | 系统选择及本机确认后授权，校验来源与 DTO；不传私有路径或字节 |
| `apps/desktop/src/main/discovery-advertiser.ts` | 服务运行期间用 `@homebridge/ciao` 做 mDNS 广播，状态进服务快照的 `discovery` | 服务 IPC 启停时调用，退出前由 `index.ts` 停止；失败不影响 HTTP 服务，30 秒重试 |
| `apps/desktop/src/main/sync-scanner.ts`、HTTP sync 路由、service bridge/IPC | Windows 本次递归扫描、原生哈希及会话内查询/取消 | 单扫描，最多保留 32 份结果，有条目、深度、JSON 和期限预算；只读源；取消或停止要等流关闭；结果不持久化 |
| `apps/desktop/src/main/sync-writer.ts`、`sync-target-files.ts`、`target-operation.ts`；transfer-registry、directory-adapter、启动 | 确认计划的目标目录创建、同卷候选替换/回读和本机恢复；旧批次共用互斥 | 写入前备份目标目录全部文件，逐项报告实际结果，首次失败停止；同路径对象替换产生新 ID；原生流和候选不跨桥 |
| `apps/desktop/src/main/restore-registry.ts`、`sync-ipc.ts`、`src/bridge/sync-bridge.ts` | 进程内异步恢复、有限复制与恢复桥、同次原生计划/结果核对 | 普通准备不占目标名额，确认后借用并保留至清理成功；任务和结果可在页面刷新后查询；不接收路径或字节；电脑发起的方法转给 `remote-sync-requests.ts` |
| `apps/desktop/src/renderer/src/features/backup`、`features/transfer/SyncCopyDetails.tsx`、`use-sync-details.ts`、`platform/sync-adapter.ts` | 备份开关/列表、恢复预览与确认、复制计划/实际结果、普通本机重扫 | 复用原生计划和结果；发送完成和移动端实际写入是两个状态；切页只停止轮询，不取消原生任务 |
| `apps/desktop/test/`、`apps/desktop/README.md` | Windows 目录、归档、HTTP 与发布的最小长期回归及接口说明 | 测试只用合成数据；真实目录只读验证，机器路径不提交 |

## 4. 移动端网页层

| 路径 | 作用 | 重要约定 |
| --- | --- | --- |
| `apps/mobile/src/app`、`features`、`components`、`styles` | 独立移动入口、导航、游戏卡片、底部弹层和 antd-mobile 页面 | 优先移动组件；使用桌面组件也保留触控区域，操作卡片至少 64px；系统返回由移动端协调 |
| `apps/mobile/src/features/transfer`、`src/platform` | 双端目录比较、手动连接、方向、计划和原生任务显示 | 当前层浏览；两列独立滚动，时间精确到分钟；业务不判断前后台，重载后查询同一原生传输任务；源文件内容不经过网页 |
| `apps/mobile/src/components/PageSlide.tsx`、`apps/mobile/src/app/press-feedback.ts` | 移动端的切页平移和按下遮罩 | 桌面端的交互效果写在 desktop.css；shared 的 pressable.css 只定义遮罩的形状 |
| `apps/mobile/src/platform/saf-directory-bridge.ts`、`saf-directories.ts`、`test/`、`README.md` | 受限 TS 桥、原生绑定、数据模型检查与调用说明 | 网页预览不支持；只传公开 DTO/ID，没有内容或写入方法 |
| `apps/mobile/src/platform/http-transfer-bridge.ts`、`http-transfers.ts` | 有限 TS 任务桥与 native 当前上下文/角色/结果校验、顺序事件订阅 | 浏览器不支持；通知和目标授权是显式动作，任务和清单只存本进程；订阅 remove 不取消传输 |

## 5. Android 原生

Java 源码都在 `apps/mobile/android/app/src/main/java/io/github/galgame/savedatasync/`，下表只写文件名。

| 路径 | 作用 | 重要约定 |
| --- | --- | --- |
| `apps/mobile/android/` | Capacitor 生成的原生工程与项目 Wrapper | minSdk 29、compile/target 36；Manifest 允许明文 HTTP；包含用户发起传输使用的 dataSync 前台服务 |
| `apps/mobile/android/app/src/main/java/io/github/galgame/savedatasync/` | Java SAF 选择、权限/配置恢复、当前层元数据和原生流 | URI 留在原生层，原生流由调用者关闭；配置不保存条目或哈希 |
| `ArchiveAdapter.java`、`ArchiveModel.java`、`ArchiveFormat.java`、`ArchiveCache.java`、`ArchiveControl.java`、`ArchiveFailure.java`、`SafArchiveSource.java`；`src/test/.../ArchiveAdapterTest.java`、`src/androidTest/.../ArchiveSafTest.java` | Java 私有源快照、严格 USTAR/单 gzip、固定预算/取消/期限与缓存归属/恢复/重试；SAF 读取后复核；格式回归和设备快照 | 不做 JSON/HTTP/目标发布，文件内容不跨桥；句柄关闭读流后 close；进程独占覆盖待清理资源；夹具与 Windows 共用；缺少实际目录授权时测试失败而不是跳过 |
| `NewFilePublisher.java`、`PublicationModel.java`、`PublicationJson.java`、`SafPublicationBackend.java`、`NewFilePublisherTest.java` | 原生显式写授权/只读预检、创建前后核实、非截断写入/回读、单文件结果及清理重试 | 只操作同根已有父目录中确知的新建条目；常规描述符身份保护已有文件；原文和 URI 不跨桥，清理失败保持进程名额；设备授权只用于合成目标；接口见移动 README |
| `TransferJson/Schema/Http/Engine.java`、`HttpTransfersPlugin.java`、`TransferRuntime/Service.java`、`SafRuntime.java` | 严格 HTTP/JSON、双向原生编排及应用级任务、持续通知和 Activity 重连 | 文件不跨 JS；用户发起后后台继续，完整校验后逐项发布；服务不导出、不自动重启旧任务；只读桥和传输共享当前 SAF 引用 |
| `SyncScanner.java`、`SafSyncSource.java`、`SyncScansPlugin.java`；移动 `platform/sync-scan-bridge.ts`、`sync-scans.ts` | 本次 SAF 递归扫描、原生哈希、取消和有限扫描桥 | 普通只读操作，不加保活或前后台处理；结果只存内存并校验 rootId/scanId，内容和 URI 不跨桥 |
| `BackupStore/Model/Files.java`、`AndroidBackupIo.java`、`SyncBackupsPlugin.java`；移动 `platform/backup-bridge.ts`、`backups.ts` | 用户可手动管理的持久备份、按份数轮换、恢复材料引用和有限本机查询 | 写 `Android/data/<包名>/files/backups`，设置留在内部目录；真实身份和链接数用 Os.lstat 检查；数据不跨桥；供 SyncWriter 复用 |
| `SyncPlanModel.java`、`SyncWriter.java`、`SafSyncBackend.java`、`SyncWriteRuntime.java`、`SyncWritesPlugin.java`、`TargetOperation.java`；移动 `platform/sync-write-bridge.ts`、`sync-writes.ts` | 确认计划的独立复核、SAF 目录创建/受保护覆盖与本机恢复、应用级任务及有限桥 | 整批复核和备份后写入，常规 FD 身份/rw/最终长度与回读；旧传输共用互斥，恢复预览与结果各有查询入口；应用不判断前后台 |
| `SyncJobModel.java`、`SyncTransferEngine/Runtime.java`、`SyncTransfersPlugin.java`；移动 `platform/sync-transfer-bridge.ts`、`sync-transfers.ts`；Windows `main/sync-registry.ts`、`upload-body.ts` | Android → Windows 的普通扫描准备、同次确认、原生归档/上传、保护后写入及实际结果查询 | 登记、清单和内容各一次，回执丢失只查询；两端任务共用原生名额，只有实际传输保持通知，长源读取通过原生心跳确认通信；页面重建按 ID 查询，不恢复或重放 |
| `DeviceDiscoveryPlugin.java`、`DiscoveryBrowser.java`；移动 `platform/device-discovery.ts` | 局域网 DNS-SD 搜索：NsdManager 搜索与解析、按订阅者启停的 TS 桥 | 原生只给实例名、端口、IPv4 和 TXT 文本，TXT 在 TS 用 shared 校验；状态在原生单个 worker 线程上 |
| `QrScannerPlugin.java`、`QrCameraSession.java`、`QrFrameDecoder.java`；移动 `platform/qr-scanner.ts`、`features/devices/ScanPage.tsx` | 扫码：相机权限、取景、逐帧识别二维码，扫到后交给 `connectCandidates` | 原生只给二维码原文，内容在 TS 用 shared 的 `parseConnectionQrText` 校验；相机绑定 Activity 生命周期，取景画面在透明的 WebView 下面，页面用 html 上的 `camera-live` 让出背景 |
| `apps/mobile/android/app/src/test/`、`src/androidTest/` | Java 纯边界与 3 条设备路径：SAF 读取、归档互通、实际 SAF 快照 | 独立私有夹具与真实选择器授权；真实源只读 |
