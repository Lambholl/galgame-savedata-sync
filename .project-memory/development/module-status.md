---
doc_type: module-status
status: active
priority: high
owner: development
updated: 2026-10-26
tags: [模块状态, 开发进度]
related_files: []
---

# 模块状态

## 目录

- [1. 当前模块](#1-当前模块)
- [2. 状态说明](#2-状态说明)

只记录当前存在的模块。模块被移除时删除对应行，历史由 Git 保存。

## 1. 当前模块

已建立工程基础设施、双端空壳、共享契约及双端目录读取适配；新文件发布、HTTP 与同步流程尚未实现。后续顺序见[路线图](../project/roadmap.md)与[工作包](work-packages.md)。双端真实目录只读检查通过；Android API 33 与旧 API 35 的选择/取消和重启授权恢复分别通过，API 29 与其它提供者仍待矩阵验证。done 仅表示对应模块范围完成，不代表完整产品可用。

| 模块 | 状态 | 负责人 | 相关文件 | 风险 | 下一步 |
| --- | --- | --- | --- | --- | --- |
| 工作区与质量配置 | done | 开发 | 根目录配置、packages/shared、scripts/check-text.mjs | — | 维护质量检查与固定依赖 |
| 本地设备/目录共享模型 | done | 开发 | packages/shared/src/contracts.ts、validation.ts、protocol.ts | 纯 DTO 不保证平台权限/实际 IO | 本地 DTO 与有限桥继续复用；传输数据已由 WP-011 改为批量模型 |
| WP-011 共享批量契约 | done | 开发 | packages/shared/src/batch-*.ts、data-validation.ts、test、README.md | 只验证数据/上下文，不解析归档/JSON 文本或执行网络、发布、计时 | 原位修订 v1 完成；32 项运行时、16 项类型反例与 pnpm check（含既有目录桥及双端构建）通过，无依赖变化；下一包 WP-012，无需 ADB |
| 双端私有归档 | not-started | 开发 | docs/plans/m001-tar-gzip-protocol.md；WP-012/013 的后续代码 | 实际格式/资源计数/严格结束/取消/清理尚无正式实现证据，独立基准不能替代 | WP-012 Windows 归档无需 ADB；WP-013 Java 纯 IO/构建可无设备，实际 SAF 读流验收需设备 |
| Windows 目录读取适配 | done | 开发 | apps/desktop/src/main/directory-*.ts、src/directory-bridge.ts、preload、test | 无源目录写入或 HTTP；系统选择器人工交互待界面阶段；路径检查不提供恶意并发命名空间隔离 | 已通过 15 项测试、真实目录只读校验、preload 构建隔离加载及 pnpm check；暂存发布由 WP-009 实现 |
| Windows 空壳 | done | 开发 | apps/desktop | 尚无项目管理、HTTP 服务和最终目录操作界面 | WP-007 接入界面；本包没有增加 UI 组件 |
| Android 网页空壳 | done | 开发 | apps/mobile/src、Vite/Capacitor 配置 | SAF 桥已存在，界面尚未接入目录按钮或同步功能 | 在业务实现授权后继续 |
| Java SAF 读取适配 | done | 开发 | apps/mobile/README.md、原生插件、src/saf-* 与测试 | 无写入/HTTP；API 29、其它提供者及实际撤权/目录移除待矩阵；流调用者必须关闭资源 | 5 项桥、4 项新增 Java 单元、lint/双 APK、旧 API 35 真实目录及 API 33 合成夹具复测通过；本轮完整批次和独立交互回执已收齐，内容/mtime 与 ctime 边界见回归状态；写入留 WP-010 |
| Android 原生工程与审计 | done | 开发 | apps/mobile/android、scripts/android-inventory.gradle | 既有审计证据不代表全部系统/提供者能力通过 | 维持 pnpm android:test，依赖变化后复审 |
| 工具链安全检查 | done | 开发 | scripts/security-*、scripts/toolchain-policy* | — | 依赖变更后重新审计与构建 |

## 2. 状态说明

| 状态 | 含义 |
| --- | --- |
| not-started | 尚未开始 |
| active | 正在开发 |
| blocked | 被阻塞 |
| done | 已完成 |
