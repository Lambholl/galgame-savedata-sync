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

已建立工程基础设施、双端空壳、共享契约及 Windows 目录读取适配；Android SAF、新文件发布、HTTP 与同步流程尚未实现。后续顺序见[路线图](../project/roadmap.md)与[工作包](work-packages.md)。Windows 真实目录只读检查通过，Android 业务真机验证仍未执行。done 仅表示对应模块范围完成，不代表完整产品可用。

| 模块 | 状态 | 负责人 | 相关文件 | 风险 | 下一步 |
| --- | --- | --- | --- | --- | --- |
| 工作区与质量配置 | done | 开发 | 根目录配置、packages/shared、scripts/check-text.mjs | — | 维护质量检查与固定依赖 |
| WP-001 共享契约 | done | 开发 | packages/shared/src、packages/shared/test、packages/shared/README.md | 纯数据验证不代表平台操作已验证 | 维护版本 1 契约及检查 |
| Windows 目录读取适配 | done | 开发 | apps/desktop/src/main/directory-*.ts、src/directory-bridge.ts、preload、test | 无源目录写入或 HTTP；系统选择器人工交互待界面阶段；路径检查不提供恶意并发命名空间隔离 | 已通过 15 项测试、真实目录只读校验、preload 构建隔离加载及 pnpm check；暂存发布由 WP-009 实现 |
| Windows 空壳 | done | 开发 | apps/desktop | 尚无项目管理、HTTP 服务和最终目录操作界面 | WP-007 接入界面；本包没有增加 UI 组件 |
| Android 网页空壳 | done | 开发 | apps/mobile/src、Vite/Capacitor 配置 | 尚未接入任何目录授权或同步功能 | 在业务实现授权后继续 |
| Android 原生工程与审计 | done | 开发 | apps/mobile/android、scripts/android-inventory.gradle | 无真机验证 | 实现业务能力并安排设备验证 |
| 工具链安全检查 | done | 开发 | scripts/security-*、scripts/toolchain-policy* | — | 依赖变更后重新审计与构建 |

## 2. 状态说明

| 状态 | 含义 |
| --- | --- |
| not-started | 尚未开始 |
| active | 正在开发 |
| blocked | 被阻塞 |
| done | 已完成 |
