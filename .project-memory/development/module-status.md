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

已实现工程基础设施、双端空壳、本地/批量共享契约、双端目录读取、Windows 私有归档及 HTTP sender；Windows 原生单文件非覆盖发布已实现；Java 归档、HTTP receiver/Android 网络、批次编排与同步流程尚未实现。后续顺序见[路线图](../project/roadmap.md)与[工作包](work-packages.md)。双端真实目录只读检查通过；Android API 33 与 API 35 的选择/取消和重启授权恢复分别通过，API 29 与其它提供者仍待矩阵验证。done 仅表示对应模块范围完成，不代表完整产品可用。

| 模块 | 状态 | 负责人 | 相关文件 | 风险 | 下一步 |
| --- | --- | --- | --- | --- | --- |
| 工作区与质量配置 | done | 开发 | 根目录配置、packages/shared、scripts/check-text.mjs | — | 维护质量检查与固定依赖 |
| 本地设备/目录共享模型 | done | 开发 | packages/shared/src/contracts.ts、validation.ts、protocol.ts | 纯 DTO 不保证平台权限/实际 IO | 本地 DTO 与有限桥继续复用，传输使用独立批量模型 |
| 共享批量契约 | done | 开发 | packages/shared/src/batch-*.ts、data-validation.ts、test、README.md | 只验证数据/上下文，不解析归档/JSON 文本或执行网络、发布、计时 | v1 批量模型、32 项运行时与 16 项类型反例通过；供后续 HTTP/Java 归档包复用 |
| Windows 私有归档 | done | 开发 | apps/desktop/src/main/archive-*.ts、目录读流、test/fixtures/archive-v1.json、归档测试、README.md | 归档模块不负责 HTTP/目标发布；没有全量 GiB 或峰值内存/功耗证据；不承诺恶意并发命名空间隔离 | 20 项归档专项通过，源只读、缓存独占/所有权/取消与重试成立；HTTP sender 与新文件发布已复用；后续 WP-005 编排 receiver |
| Windows HTTP sender 与任务注册 | done | 开发 | apps/desktop/src/main/http-*.ts、transfer-registry.ts、index.ts、HTTP 集成测试 | 默认不监听；上传/receiver、真实 LAN/Android 与最终界面未验收 | 25 项回环/TCP 与原生期限/清理专项通过，已提交 096dfec；下一 WP-005 集成接收 |
| Windows 原生新文件发布 | done | 开发 | new-file-publisher.ts、publication-errors.ts、目录原生定位、退出收尾及专项测试 | 仅明确授权的独立测试根；无 HTTP receiver/UI、覆盖或目录删除；不跨进程恢复候选所有权 | 24 项专项与完整工程检查（85 桌面等）通过；不支持 link 时失败；其他卷/名称等价、强杀恢复与资源矩阵缺口保留；下一 WP-005 无需 ADB |
| Android 私有归档 | not-started | 开发 | docs/plans/m001-tar-gzip-protocol.md；WP-013 的后续 Java 代码及固定夹具 | Windows/Python 证据不能替代 Java/SAF 格式及资源/生命周期验证 | WP-013 复用固定夹具与故障矩阵；纯 IO/构建可无设备，实际 SAF 读流验收需设备 |
| Windows 目录读取适配 | done | 开发 | apps/desktop/src/main/directory-*.ts、src/directory-bridge.ts、preload、test | 无源目录写入或 HTTP；系统选择器人工交互待界面阶段；路径检查不提供恶意并发命名空间隔离 | 16 项目录/IPC 测试、真实目录只读校验及 preload 构建隔离加载通过；原生定位/身份/元数据供独立发布适配复用，读取桥不增加写入口 |
| Windows 空壳 | done | 开发 | apps/desktop | 尚无项目管理、服务控制和最终目录操作界面 | WP-007 接入目录与传输验证界面 |
| Android 网页空壳 | done | 开发 | apps/mobile/src、Vite/Capacitor 配置 | SAF 桥已存在，界面尚未接入目录按钮或同步功能 | 在业务实现授权后继续 |
| Java SAF 读取适配 | done | 开发 | apps/mobile/README.md、原生插件、src/saf-* 与测试 | 无写入/HTTP；API 29、其它提供者及实际撤权/目录移除待矩阵；流调用者必须关闭资源 | 5 项桥、Java 单元、lint/双 APK、API 35 真实目录及 API 33 合成夹具验证通过；属性边界见回归状态；写入留 WP-010 |
| Android 原生工程与审计 | done | 开发 | apps/mobile/android、scripts/android-inventory.gradle | 既有审计证据不代表全部系统/提供者能力通过 | 维持 pnpm android:test，依赖变化后复审 |
| 工具链安全检查 | done | 开发 | scripts/security-*、scripts/toolchain-policy* | — | 依赖变更后重新审计与构建 |

## 2. 状态说明

| 状态 | 含义 |
| --- | --- |
| not-started | 尚未开始 |
| active | 正在开发 |
| blocked | 被阻塞 |
| done | 已完成 |
