---
doc_type: module-status
status: active
priority: high
owner: development
updated: 2026-10-27
tags: [模块状态, 开发进度]
related_files: []
---

# 模块状态

## 目录

- [1. 当前模块](#1-当前模块)
- [2. 状态说明](#2-状态说明)

只记录当前存在的模块。模块被移除时删除对应行，历史由 Git 保存。

## 1. 当前模块

工程基础设施、双端空壳、本地/批量共享模型、双端目录读取、Windows 私有归档及 HTTP sender 已经可用；Windows 原生非覆盖发布及 HTTP receiver 批次编排可用；Java 私有归档与 SAF 单文件发布完成实际 API 33 集成；Android HTTP、任务编排和持续通知可用；最小验证界面已完成，完整同步流程还没实现。后续顺序见[路线图](../project/roadmap.md)与[工作包](work-packages.md)。双端真实目录只读检查通过；Android API 33 与 API 35 的选择/取消和重启授权恢复通过，API 29 与其它提供者还要验证。done 表示模块范围内的工作完成；完整产品仍取决于未完成工作包。

| 模块 | 状态 | 负责人 | 相关文件 | 风险 | 下一步 |
| --- | --- | --- | --- | --- | --- |
| Windows 分发包 | done | 开发 | apps/desktop/electron-builder.json、scripts/package-windows.mjs、双层 package.json、pnpm-lock.yaml | 当前未配置代码签名；使用已编译资源与隔离的最小应用清单 | 桌面资源编译及 electron-builder x64 安装版/免安装版打包成功，产物位于 apps/desktop/release；新增依赖 npm 审计通过；安装运行由用户验收 |
| 正式设备/游戏/设置界面 | implemented | 开发 | packages/ui、双端 App/library-adapter、library-bridge、library-ipc/store、共享 library.ts | 一个游戏关联多台设备，首期仅一个连接；覆盖/删除/备份恢复仍按 M-004 开放 | 按用户要求由用户验收；实现前半段 pnpm check、antd、既有 56 项 JS 测试和依赖审计通过，最终以交付构建为准 |
| Android HTTP 与持续通知 | done | 开发 | TransferJson/Schema/Http/Engine、HttpTransfersPlugin、TransferRuntime/Service、SafRuntime、TS 桥及最小检查 | 全校验前不发布，sender sent 与 receiver 成功分开；应用级任务持有，Activity 暂停/销毁时任务继续，通知提供显式取消；任务只由用户发起，不调度或重放旧任务 | Java/TS 桥、lint/双 APK/互通及 TC-011 的正式 LAN、后台、重连、取消和外部内容属性核对通过；供 WP-007 界面复用 |
| 工作区与质量配置 | done | 开发 | 根目录配置、packages/shared、scripts/check-text.mjs | — | 维护质量检查与固定依赖 |
| Android SAF 单文件发布 | done | 开发 | NewFilePublisher、PublicationModel/Json、SafPublicationBackend/DirectoryStore、单元测试及既有原生集成 | 排他创建取决于提供者能力；未知归属不写入或删除，目标所有权只在当前进程内有效；写入限定在明确授权的合成根 | 单元、lint/双 APK/原生互通及 API 33 实际 SAF 发布、外部原文与控制属性核对通过；供 WP-006 原生 HTTP 复用 |
| 双端系统明暗主题 | done | 开发 | 桌面 App/use-system-dark-mode/main/style；移动 system-theme/main/style、MainActivity、日夜主题/颜色资源 | 当前跟随系统，不增加手动开关或主题偏好存储 | 双端浏览器与 API 33 真机的初次加载、动态切换、原生背景和系统栏同步已通过实际操作与截图验收；未保留界面自动化测试 |
| 本地设备/目录共享模型 | done | 开发 | packages/shared/src/contracts.ts、validation.ts、protocol.ts | 纯 DTO 只描述数据；平台权限和实际 IO 由适配器处理 | 本地 DTO 与有限桥继续复用，传输使用独立批量模型 |
| 共享批量模型 | done | 开发 | packages/shared/src/batch-*.ts、data-validation.ts、test、README.md | 处理数据与上下文；归档/JSON 解析、网络、发布和计时由其他模块负责 | v1 批量模型与稳定数据关系测试通过；供 HTTP、Java 归档和原生发布复用 |
| Windows 私有归档 | done | 开发 | apps/desktop/src/main/archive-*.ts、目录读流、test/fixtures/archive-v1.json、归档测试、README.md | 归档模块只处理私有缓存；HTTP 和目标发布由其他模块负责。全量 GiB、峰值内存/功耗还没测；恶意并发重排命名空间不在隔离范围内 | 源只读、缓存独占/所有权/取消与重试成立；独立格式夹具与 HTTP/发布模块复用通过 |
| Windows HTTP sender 与任务注册 | done | 开发 | apps/desktop/src/main/http-*.ts、transfer-registry.ts、index.ts、HTTP 回归 | 默认不监听；真实 LAN/Android 已通过 TC-007，最小界面已由 WP-007 接入并验证 | 最小 HTTP 回归覆盖公开协议、单次领取、期限和清理；receiver 已由 WP-005 集成 |
| Windows 原生新文件发布 | done | 开发 | new-file-publisher.ts、publication-errors.ts、目录原生定位、退出收尾及回归 | 写入限定在明确授权的独立测试根；HTTP/UI、覆盖和目录删除由其他模块处理；候选所有权只在当前进程内有效 | 非覆盖发布、最终回读和清理回归通过；不支持 link 时失败；其他卷、名称等价与强杀恢复仍待验证 |
| Windows HTTP receiver 与批次发布 | done | 开发 | upload-receiver.ts、transfer-registry.ts、http-*.ts、archive-adapter.ts、test/http-receiver.test.mjs | 服务默认不监听，也不授予写权限；202 确认压缩体已收齐，终态另行查询；请求只查询，目标不回滚；LAN/Android 已通过 TC-007，资源规模待 WP-008 | 最小接收回归及双端构建通过；Java 归档、SAF 发布和 Android HTTP 与 WP-007 界面均已集成，平台组合留 WP-008 |
| Android 私有归档 | done | 开发 | ArchiveAdapter/Model/Format/Cache/Control/Failure.java、SafArchiveSource.java、单元/设备测试与互通脚本 | 处理原生归档与私有缓存；JSON/HTTP、目标发布和前台网络调度由其他模块负责；固定预算是技术限制 | Java 单元、lint/双 APK、固定夹具、实际 SAF 快照与 Windows/JVM 互通通过；由 WP-006 复用 |
| Windows 目录读取适配 | done | 开发 | apps/desktop/src/main/directory-*.ts、src/directory-bridge.ts、preload、test | 源目录只读；系统选择器与目录界面已通过 WP-007 实操；路径检查覆盖可观察边界，恶意并发重排命名空间不在隔离范围内 | 目录/IPC 回归、真实目录只读校验及 preload 构建隔离加载通过；原生定位与元数据供发布适配复用 |
| Windows 验证界面 | done | 开发 | apps/desktop/src/renderer、service-bridge.ts、main/service-ipc.ts | 服务与根写授权分别显式操作；原生层持有文件路径和内容，界面只读公开快照 | 目录浏览、元数据、服务启停、接收授权/撤销、取消和清理重试已实现并实操；完整项目管理留后续 |
| Android 验证界面 | done | 开发 | apps/mobile/src/App、DirectoryPanel、TaskPanel、use-transfer-task | 手机发起原生传输；只在本次独立测试目标新建文件；地址与目录授权分开保存 | 手动连接、双端目录、方向/文件/目标名称、真实进度、逐项结果、取消与页面重载查询通过 API 33 LAN 验证；完整平台组合留 WP-008 |
| Java SAF 读取适配 | done | 开发 | apps/mobile/README.md、原生插件、src/saf-* 与最小回归 | 只开放只读读取；API 29、其它提供者及实际撤权/目录移除还要验证；流调用者负责关闭资源 | TS 桥、Java 单元、lint/双 APK、API 35 真实目录及 API 33 合成夹具验证通过；属性边界见回归状态；读取桥保持只读 |
| Android 原生工程与审计 | done | 开发 | apps/mobile/android、scripts/android-inventory.gradle | 审计覆盖依赖公告；系统/提供者能力另按设备验证 | 维持 pnpm android:test，依赖变化后复审 |
| 工具链安全检查 | done | 开发 | scripts/security-*、scripts/toolchain-policy* | — | 依赖变更后重新审计与构建 |

## 2. 状态说明

| 状态 | 含义 |
| --- | --- |
| not-started | 尚未开始 |
| active | 正在开发 |
| blocked | 被阻塞 |
| done | 已完成 |
