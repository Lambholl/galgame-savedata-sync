---
doc_type: module-status
status: active
priority: high
owner: development
updated: 2026-11-04
tags: [模块状态, 开发进度]
related_files: []
---

# 模块状态

## 目录

- [1. 当前模块](#1-当前模块)
- [2. 状态说明](#2-状态说明)

只记录当前存在的模块。模块被移除时删除对应行，历史由 Git 保存。验收结论和支持范围见 `docs/plans/m002-sync-copy.md` 第 6 节，验证缺口见[测试覆盖缺口](../testing/coverage-gaps.md)，后续顺序见[路线图](../project/roadmap.md)。

## 1. 当前模块

| 模块 | 状态 | 负责人 | 相关文件 | 边界与风险 | 下一步 |
| --- | --- | --- | --- | --- | --- |
| 四语言界面、错误与原生通知 | done | 开发 | shared i18n/result/ui、双端 app/features/platform、desktop main、Android Java/res | Android 通知语言切换没有真机复核 | 真机复核通知语言 |
| Android 确认执行、结果与本机恢复界面 | done | 开发 | mobile sync-adapter、SyncCopy/Plan/Task/Backup 页面、useSyncTasks、SyncWrites/BackupsPlugin | 双向执行由原生持有；发送完成与目标成功分开 | — |
| Windows 计划、结果与本机恢复界面 | done | 开发 | restore-registry、sync-ipc/bridge、preload、备份/任务页、platform/sync-adapter | 进程重启不恢复任务，备份和配置保留 | — |
| Windows 分发包 | done | 开发 | apps/desktop/electron-builder.json、scripts/package-windows.mjs、双层 package.json、pnpm-lock.yaml | 没有配置代码签名；使用已编译资源与隔离的最小应用清单；产物位于 apps/desktop/release | — |
| 正式设备/游戏/设置界面 | done | 开发 | apps/mobile/src、apps/desktop/src/renderer/src、apps/shared、桌面 bridge 与 library-ipc/store | 一个游戏关联多台设备，同时只连一台；镜像删除还没有实现 | M-004 补镜像删除 |
| Android HTTP 与持续通知 | done | 开发 | TransferJson/Schema/Http/Engine、HttpTransfersPlugin、TransferRuntime/Service、SafRuntime、TS 桥及最小检查 | 全部校验前不发布，sender sent 与 receiver 成功分开；应用级任务持有，Activity 暂停/销毁时任务继续，通知提供显式取消；任务只由用户发起，不调度或重放旧任务 | — |
| 工作区与质量配置 | done | 开发 | 根目录配置、apps/shared、scripts/check-text.mjs | — | — |
| Android SAF 单文件发布 | done | 开发 | NewFilePublisher、PublicationModel/Json、SafPublicationBackend/DirectoryStore、单元测试及既有原生集成 | 排他创建取决于提供者能力；未知归属不写入或删除，目标所有权只在当前进程内有效 | — |
| 双端系统明暗主题 | done | 开发 | 桌面 app/DesktopApp、main、styles、preferences-*；移动 app/system-theme、app-preferences、main、styles、MainActivity、日夜主题/颜色资源 | 支持跟随系统、浅色、深色；偏好保存在本机，重启后继续使用；桌面原生窗口和移动系统栏随解析后的主题更新 | — |
| 本地设备/目录共享模型 | done | 开发 | apps/shared/src/protocol/contracts.ts、validation.ts、protocol.ts | 纯 DTO 只描述数据；平台权限和实际 IO 由适配器处理 | — |
| 共享批量模型 | done | 开发 | apps/shared/src/protocol/batch-*.ts、data-validation.ts、test、README.md | 处理数据与上下文；归档/JSON 解析、网络、发布和计时由其他模块负责 | — |
| 当前扫描与覆盖计划共享模型 | done | 开发 | apps/shared/src/sync、src/index.ts、README.md | 纯数据与确定比较；实际扫描/备份/写入、权限、会话及期限由平台包处理 | — |
| Android → Windows 复制编排 | done | 开发 | shared sync jobs、Windows sync-registry/upload-body、Android SyncJobModel/SyncTransferEngine/Runtime/Plugin/Service、TS bridge | 真实存档在支持范围内开放 | — |
| Windows → Android 复制编排 | done | 开发 | Windows sync-registry/HTTP/source 归档、Android SyncTransferEngine/Runtime/Model、SyncWriter/BackupStore、TS bridge | 手机独立报告目标结果；真实存档在支持范围内开放 | — |
| 固定项目映射与传输前复核 | done | 开发 | apps/shared/src/library/project-binding.ts、双端 library store/adapter/IPC | 配置/设备/目录 ID 固定到任务；实际扫描和写入由平台包处理；TransferRequest 调用方需提供 projectId | — |
| Windows 独立备份与轮换 | done | 开发 | backup-store/files/ipc、backup-bridge、启动/preload、directory-adapter | 原生写入/恢复、Android 上传接收及桌面页面复用这些材料 | 待维护者决定：电脑端是否也改成可手动管理 |
| Windows 受保护写入与恢复 | done | 开发 | sync-writer、sync-target-files、target-operation、directory-adapter、transfer-registry、restore-registry、启动 | 其他卷、特殊名称和崩溃残留没有验收，见覆盖缺口 | — |
| Android 独立备份与轮换 | active | 开发 | BackupStore/Model/Files、AndroidBackupIo、SyncBackupsPlugin、TS backup bridge | 备份移到 `Android/data` 后只在 JVM 上核对，真机未验证 | 手机连回后按回归记录验证 |
| Android 受保护写入与本机恢复 | done | 开发 | SyncPlanModel/Writer、SafSyncBackend、SyncWriteRuntime/Plugin、TargetOperation、TS sync-write bridge | Android 覆盖是原地写入，中断会留下新旧混合的文件，只能靠写入前备份恢复 | — |
| Windows 当前扫描与内容指纹 | done | 开发 | sync-scanner.ts、http-service/wire、service-bridge/ipc、shared/sync | 只读扫描；没有远端恢复 | — |
| Android 当前扫描与内容指纹 | done | 开发 | SyncScanner/SafSyncSource/SyncScansPlugin、TS sync-scan bridge | 普通本地只读扫描，不加保活或前后台处理；原生复制/备份/本机恢复声明为 supported | — |
| Windows 私有归档 | done | 开发 | apps/desktop/src/main/archive-*.ts、目录读流、test/fixtures/archive-v1.json、归档测试、README.md | 归档模块处理私有缓存；HTTP 和目标发布由其他模块负责；恶意并发重排命名空间不在隔离范围内 | — |
| Windows HTTP sender 与任务注册 | done | 开发 | apps/desktop/src/main/http-*.ts、transfer-registry.ts、index.ts、HTTP 回归 | 默认不监听 | — |
| Windows 原生新文件发布 | done | 开发 | new-file-publisher.ts、publication-errors.ts、目录原生定位、退出收尾及回归 | 写入限定在明确授权的根；不支持 link 时失败；候选所有权只在当前进程内有效；其他卷、名称等价与强杀恢复没有验证 | 见覆盖缺口 |
| Windows HTTP receiver 与批次发布 | done | 开发 | upload-receiver.ts、transfer-registry.ts、http-*.ts、archive-adapter.ts、test/http-receiver.test.mjs | 服务默认不监听，也不授予写权限；202 确认压缩体已收齐，终态另行查询；请求只查询，目标不回滚 | — |
| Android 私有归档 | done | 开发 | ArchiveAdapter/Model/Format/Cache/Control/Failure.java、SafArchiveSource.java、单元/设备测试与互通脚本 | 处理原生归档与私有缓存；JSON/HTTP、目标发布和前台网络调度由其他模块负责；固定预算是技术限制 | — |
| Windows 目录读取适配 | done | 开发 | apps/desktop/src/main/directory-*.ts、src/bridge/directory-bridge.ts、preload、test | 源目录只读；路径检查覆盖可观察边界，恶意并发重排命名空间不在隔离范围内 | — |
| Windows 设备页服务控制 | done | 开发 | apps/desktop/src/renderer/src/features/devices、src/bridge/service-bridge.ts、main/service-ipc.ts | 服务启停在设备页显式操作；原生层持有文件路径和内容，界面只读公开快照 | — |
| Android 连接与传输页 | done | 开发 | apps/mobile/src/app、features/transfer、platform | 手机可发起或执行电脑发起的复制；地址与目录授权分开保存；v1 批量接口只新建文件 | — |
| Java SAF 读取适配 | done | 开发 | apps/mobile/README.md、原生插件、src/platform/saf-* 与最小回归 | 读取桥只读；流调用者负责关闭资源 | — |
| Android 原生工程与审计 | done | 开发 | apps/mobile/android、scripts/android-inventory.gradle | 审计覆盖依赖公告；系统/提供者能力另按设备验证 | 依赖变化后复审 |
| 工具链安全检查 | done | 开发 | scripts/security-*、scripts/toolchain-policy* | — | 依赖变更后重新审计与构建 |

## 2. 状态说明

| 状态 | 含义 |
| --- | --- |
| not-started | 尚未开始 |
| active | 正在开发 |
| blocked | 被阻塞 |
| done | 已完成 |
