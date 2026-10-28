---
doc_type: module-status
status: active
priority: high
owner: development
updated: 2026-10-29
tags: [模块状态, 开发进度]
related_files: []
---

# 模块状态

## 目录

- [1. 当前模块](#1-当前模块)
- [2. 状态说明](#2-状态说明)

只记录当前存在的模块。模块被移除时删除对应行，历史由 Git 保存。

## 1. 当前模块

M-001 已完成：工程基础设施、共享模型、双端目录/归档/发布/HTTP、通知保持和独立界面均已可用，目标真机组合与满额 1 GiB 双向资源验收通过。完整同步流程还没实现，后续顺序见[路线图](../project/roadmap.md)与[工作包](work-packages.md)。

| 模块 | 状态 | 负责人 | 相关文件 | 风险 | 下一步 |
| --- | --- | --- | --- | --- | --- |
| Windows 分发包 | done | 开发 | apps/desktop/electron-builder.json、scripts/package-windows.mjs、双层 package.json、pnpm-lock.yaml | 当前未配置代码签名；使用已编译资源与隔离的最小应用清单 | 桌面资源编译及 electron-builder x64 安装版/免安装版打包成功，产物位于 apps/desktop/release；新增依赖 npm 审计通过；安装运行由用户验收 |
| 正式设备/游戏/设置界面 | done | 开发 | apps/mobile/src、apps/desktop/src/renderer/src、apps/shared、桌面 bridge 与 library-ipc/store | 一个游戏关联多台设备，首期仅一个连接；覆盖与备份恢复安排在 M-002，镜像删除仍留 M-004；当前文件传输保持仅新建 | 双端独立界面、目录选择与进程内写入授权已实现，跨端真机验收通过；后续界面接入见 WP-027/WP-028 |
| Android HTTP 与持续通知 | done | 开发 | TransferJson/Schema/Http/Engine、HttpTransfersPlugin、TransferRuntime/Service、SafRuntime、TS 桥及最小检查 | 全校验前不发布，sender sent 与 receiver 成功分开；应用级任务持有，Activity 暂停/销毁时任务继续，通知提供显式取消；任务只由用户发起，不调度或重放旧任务 | Java/TS 桥、lint/双 APK/互通及 TC-011 的正式 LAN、后台、重连、取消和外部内容属性核对通过；供 WP-007 界面复用 |
| 工作区与质量配置 | done | 开发 | 根目录配置、apps/shared、scripts/check-text.mjs | — | 维护质量检查与固定依赖 |
| Android SAF 单文件发布 | done | 开发 | NewFilePublisher、PublicationModel/Json、SafPublicationBackend/DirectoryStore、单元测试及既有原生集成 | 排他创建取决于提供者能力；未知归属不写入或删除，目标所有权只在当前进程内有效；写入限定在明确授权的合成根 | 单元、lint/双 APK/原生互通及 API 33 实际 SAF 发布、外部原文与控制属性核对通过；供 WP-006 原生 HTTP 复用 |
| 双端系统明暗主题 | done | 开发 | 桌面 app/DesktopApp、main、styles；移动 app/system-theme、main、styles、MainActivity、日夜主题/颜色资源 | 当前跟随系统，不增加手动开关或主题偏好存储 | 双端浏览器与 API 33 真机的初次加载、动态切换、原生背景和系统栏同步已通过实际操作与截图验收；未保留界面自动化测试 |
| 本地设备/目录共享模型 | done | 开发 | apps/shared/src/protocol/contracts.ts、validation.ts、protocol.ts | 纯 DTO 只描述数据；平台权限和实际 IO 由适配器处理 | 本地 DTO 与有限桥继续复用，传输使用独立批量模型 |
| 共享批量模型 | done | 开发 | apps/shared/src/protocol/batch-*.ts、data-validation.ts、test、README.md | 处理数据与上下文；归档/JSON 解析、网络、发布和计时由其他模块负责 | v1 批量模型与稳定数据关系测试通过；供 HTTP、Java 归档和原生发布复用 |
| 当前扫描与覆盖计划共享模型 | done | 开发 | apps/shared/src/sync、src/index.ts、README.md | 纯数据与确定比较；实际扫描/备份/写入、权限、会话及期限由平台包处理 | 快照/树关系、复制和本机恢复计划、备份格式/设置及实际结果守卫已实现；针对性运行、既有共享套件及工程检查通过；供 WP-018 至 WP-028 复用 |
| Android → Windows 复制编排 | done | 开发 | shared sync jobs、Windows sync-registry/upload-body、Android SyncJobModel/SyncTransferEngine/Runtime/Plugin/Service、TS bridge | 原生及有限 API 已接入；界面继续后续工作包，真实存档开放仍需 M-002 总体验收 | API 33 实际 SAF/LAN、完整备份/覆盖/跳过/保留、回执丢失/短暂查询恢复/关闭备份/目标变化/实际取消、源及手机保存配置不变已通过；回环/JVM 故障、原生心跳和新桥上下文核对通过；供 WP-027/WP-028 复用 |
| Windows → Android 复制编排 | done | 开发 | Windows sync-registry/HTTP/source 归档、Android SyncTransferEngine/Runtime/Model、SyncWriter/BackupStore、TS bridge | 原生双向 API 可用；手机独立报告目标结果，界面及总体验收继续后续工作包 | API 33 实际 SAF/LAN 覆盖/备份关闭/跳过/保留、无文件和仅目录、回执丢失、损坏归档、取消、目标/设置变化、容量拒绝、清理保留及重试通过；正式插件/通知/实际传输切后台/Activity 重建及新桥查询、原文和配置恢复核对通过；Windows 单次发送/超时/源变化/清理与备份失败重试针对性验证通过 |
| 固定项目映射与传输前复核 | done | 开发 | apps/shared/src/library/project-binding.ts、双端 library store/adapter/IPC | 配置/设备/目录 ID 固定到任务；实际扫描和写入仍由平台包处理 | 目录登记、通知后映射变化、改址/重启持久化及异设备拒绝场景通过；旧 HTTP 与持久配置格式保持，TransferRequest 调用方需提供 projectId |
| Windows 独立备份与轮换 | done | 开发 | backup-store/files/ipc、backup-bridge、启动/preload、directory-adapter | 原生写入/恢复及 Android 上传接收已复用材料；页面由后续包接入 | 独立原文回读、最近 3 次及引用保护、新进程重启/设置、源变化/校验/写入失败/取消/超时关流/容量、残留和链接保护及有限 IPC 验证通过；供 WP-027 界面复用 |
| Windows 受保护写入与恢复 | done | 开发 | sync-writer、sync-target-files、target-operation、directory-adapter、transfer-registry、启动 | 原生 API 及 Android 上传 HTTP 已接入；本机恢复页面待后续接入，其他卷/名称和崩溃残留缺口沿用登记项 | 合成目录创建/覆盖/恢复、保护当前内容及目标独有条目、输入/目标变化、实际占用文件、权限/文件系统故障、取消/超时/部分/未知结果、容量和清理归属/互斥验证通过；33 项既有桌面回归及工程构建通过；供 WP-027 复用 |
| Android 独立备份与轮换 | done | 开发 | BackupStore/Model/Files、AndroidBackupIo、SyncBackupsPlugin、TS backup bridge | 已供原生受保护写入、恢复及复制 HTTP 复用；界面由后续包接入，安卓实测使用 API 33 设备 | API 33 实际 SAF 备份、独立原文哈希/源属性、三轮保留及引用保护、进程重启和正式插件检查通过；JVM 写入故障/取消/超时/失效授权/容量/残留/链接数、失败创建及轮换残留重试和桥检查、既有套件及工程/Android 构建通过；供 WP-028 复用 |
| Android 受保护写入与本机恢复 | done | 开发 | SyncPlanModel/Writer、SafSyncBackend、SyncWriteRuntime/Plugin、TargetOperation、TS sync-write bridge | 原生目标写入、复制 HTTP 和有限本机恢复桥可用；页面由后续适配层接入 | API 33 实际 SAF 新增/缩短/清空/恢复、写入中取消及创建竞争、当前内容保护/三轮保留、恢复任务准备/执行/取消/释放通过；JVM 故障/容量、跨语言计划/结果与桥、正式插件检查通过；复制编排借用名额/确认时间、接收前容量及完整目标复核已验证；供 WP-028 界面复用 |
| Windows 当前扫描与内容指纹 | done | 开发 | sync-scanner.ts、http-service/wire、service-bridge/ipc、shared/sync | 只读扫描已接入；启用新增接收编排时声明复制/备份，远端恢复保持关闭 | 实际目录/哈希/空目录/未知长度、源变化、junction、预算、超时/取消关流、期限及 HTTP/IPC 会话边界通过；供 WP-026/WP-027 复用 |
| Android 当前扫描与内容指纹 | done | 开发 | SyncScanner/SafSyncSource/SyncScansPlugin、TS sync-scan bridge | 普通本地只读扫描，不加保活或前后台处理；原生复制/备份/本机恢复已声明 supported | API 33 实际 SAF 嵌套/空目录/中文/空文件/哈希及原文属性核对、显式取消通过；JVM 未知长度/源变化/失效授权/预算/超时/过期和桥守卫通过；既有套件、工程检查与 APK 构建通过；安卓实测使用 API 33 设备 |
| Windows 私有归档 | done | 开发 | apps/desktop/src/main/archive-*.ts、目录读流、test/fixtures/archive-v1.json、归档测试、README.md | 归档模块处理私有缓存；HTTP 和目标发布由其他模块负责；恶意并发重排命名空间不在隔离范围内 | 源只读、缓存独占/所有权/取消与重试、独立格式及满额 GiB/进程内存验收通过，接收前容量预检已实现 |
| Windows HTTP sender 与任务注册 | done | 开发 | apps/desktop/src/main/http-*.ts、transfer-registry.ts、index.ts、HTTP 回归 | 默认不监听；真实 LAN/Android 已通过 TC-007，双端界面已接入并验证 | HTTP 回归覆盖公开协议、单次领取、期限和清理；receiver 已由 WP-005 集成 |
| Windows 原生新文件发布 | done | 开发 | new-file-publisher.ts、publication-errors.ts、目录原生定位、退出收尾及回归 | 写入限定在明确授权的独立测试根；HTTP/UI、覆盖和目录删除由其他模块处理；候选所有权只在当前进程内有效 | 非覆盖发布、最终回读和清理回归通过；不支持 link 时失败；其他卷、名称等价与强杀恢复仍待验证 |
| Windows HTTP receiver 与批次发布 | done | 开发 | upload-receiver.ts、transfer-registry.ts、http-*.ts、archive-adapter.ts、test/http-receiver.test.mjs | 服务默认不监听，也不授予写权限；202 确认压缩体已收齐，终态另行查询；请求只查询，目标不回滚 | 接收回归、Java 归档、SAF 发布、Android HTTP、满额 1 GiB 真机往返及整批容量预检通过 |
| Android 私有归档 | done | 开发 | ArchiveAdapter/Model/Format/Cache/Control/Failure.java、SafArchiveSource.java、单元/设备测试与互通脚本 | 处理原生归档与私有缓存；JSON/HTTP、目标发布和前台网络调度由其他模块负责；固定预算是技术限制 | Java 单元、lint/双 APK、固定夹具、实际 SAF 快照与 Windows/JVM 互通通过；由 WP-006 复用 |
| Windows 目录读取适配 | done | 开发 | apps/desktop/src/main/directory-*.ts、src/bridge/directory-bridge.ts、preload、test | 源目录只读；系统选择器与目录界面已通过 WP-007 实操；路径检查覆盖可观察边界，恶意并发重排命名空间不在隔离范围内 | 目录/IPC 回归、真实目录只读校验及 preload 构建隔离加载通过；原生定位与元数据供发布适配复用 |
| Windows 验证界面 | done | 开发 | apps/desktop/src/renderer、src/bridge/service-bridge.ts、main/service-ipc.ts | 服务与根写授权分别显式操作；原生层持有文件路径和内容，界面只读公开快照 | 目录浏览、元数据、服务启停、目录写入授权、取消和清理重试已实现并通过真机验收 |
| Android 验证界面 | done | 开发 | apps/mobile/src/app、features/transfer、platform | 手机发起原生传输；只在本次独立测试目标新建文件；地址与目录授权分开保存 | 手动连接、双端目录、方向/文件/目标名称、真实进度、逐项结果、取消与页面重载查询通过真机验收 |
| Java SAF 读取适配 | done | 开发 | apps/mobile/README.md、原生插件、src/platform/saf-* 与最小回归 | 只开放只读读取；流调用者负责关闭资源 | TS 桥、Java 单元、lint、双 APK 和目标真机读取验收通过；读取桥保持只读 |
| Android 原生工程与审计 | done | 开发 | apps/mobile/android、scripts/android-inventory.gradle | 审计覆盖依赖公告；系统/提供者能力另按设备验证 | 维持 pnpm android:test，依赖变化后复审 |
| 工具链安全检查 | done | 开发 | scripts/security-*、scripts/toolchain-policy* | — | 依赖变更后重新审计与构建 |

## 2. 状态说明

| 状态 | 含义 |
| --- | --- |
| not-started | 尚未开始 |
| active | 正在开发 |
| blocked | 被阻塞 |
| done | 已完成 |
