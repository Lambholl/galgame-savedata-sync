---
doc_type: index
status: active
owner: project
updated: 2026-10-26
tags: [Agent导航, 项目记忆]
related_files: []
---

# 项目记忆索引

## 目录

- [1. 读取协议](#1-读取协议)
- [2. 当前工作](#2-当前工作)
- [3. 按需路由](#3-按需路由)
- [文档目录](#文档目录)

## 1. 读取协议

1. 先读本 INDEX，再根据任务和文档 `## 目录` 选择需要的原文章节。
2. 可直接使用 `rg`、`sed`、`head` 或 `cat`；需要章节切片时使用 `read --file <path> --toc|--section <标题>|--full`。
3. 任务范围变化时重新查看导航；规范、版本或路径不明确时先调查再写入。
4. 只保存项目级需求、设计、实现和验证结论，不保存特定开发机器的环境信息。

本文件提供导航、可恢复当前工作和当前文档清单，不复制项目正文。`archive/` 不进入本索引或默认搜索。

## 2. 当前工作

| 工作 | 状态 | 相关记忆文档 | 相关代码或配置 | 已完成 | 下一步 |
| --- | --- | --- | --- | --- | --- |
| 实现 WP-005 Windows HTTP 接收 | completed | development/work-packages.md、architecture/api-contracts.md、testing/test-cases.md、standards/coding-style.md | apps/desktop 原生 HTTP/注册表、归档接收检查点、发布编排与集成测试、README | WP-009 已提交 63ddb34；WP-005 上传预检/单次 PUT、压缩体确认及异步全校验、逐项发布/部分结果、取消/期限/响应丢失/清理已实现；29 项接收专项及完整 pnpm check（114 桌面/32 共享/5 移动桥、双端构建）通过；长期事实/文档已同步；记忆校验、176 文件文本与 44 份 Markdown 的 194 个链接/锚点检查通过；无新增依赖或设备操作 | 本包未提交；下一 WP-013 Java 归档，纯 IO/构建无需 ADB，实际 SAF 验证需设备；不启动下一包或操作设备 |
| 实现 WP-009 Windows 新文件暂存与发布 | completed | development/work-packages.md、architecture/api-contracts.md、testing/test-cases.md、standards/coding-style.md | apps/desktop 原生发布模块、目录原生定位、退出收尾及专项测试/README | 进程写授权/预检、同目录候选/sync/link/最终回读、结果/清理分离与重试已实现；24 项专项及完整工程检查通过；已提交 63ddb34，由 WP-005 receiver 复用 | 跨进程候选恢复、其他卷/特殊名称等价、规模资源及 Android/实际 LAN 验收保留缺口 |
| 实现 WP-004 Windows HTTP 读取与任务注册 | completed | development/work-packages.md、architecture/api-contracts.md、testing/coverage-gaps.md | apps/desktop 原生 HTTP/任务模块、退出生命周期与集成测试 | 严格协议边界、异步 sender/单次领取、会话/期限/取消、进程名额与清理重试已实现，25 项 HTTP 专项通过；已提交 096dfec | receiver 批次已由 WP-005 集成；UI/实际窗口退出、LAN/Android 与规模资源验证仍待后续包 |
| 实现 WP-012 Windows 私有归档 | completed | development/work-packages.md、architecture/api-contracts.md、testing/coverage-gaps.md | apps/desktop 原生归档/缓存、目录读流、独立格式夹具及测试 | 源快照、严格 USTAR/gzip1、预算/取消/缓存所有权与重试已实现，20 项归档专项通过；已提交 b507547，并由 WP-004 HTTP sender 复用 | Java 互通、全量 GiB、峰值内存/功耗及实际磁盘耗尽仍待后续验证；已供 Windows sender/receiver 复用 |
| 修复 CI 桌面目录测试路径差异 | completed | testing/regression-notes.md、testing/test-cases.md | apps/desktop/test/temporary-paths.test.mjs | 夹具统一采用 realpath 临时根；正常及 8.3 短路径环境 16 项目录/IPC 测试通过；完成状态已进入 Git | 修复后的远端 CI 结果仍待确认，不以本地结果代替 |
| 评估小文件归档传输 | completed | requirements/open-questions.md、testing/coverage-gaps.md | docs/experiments/transfer-benchmark-2026-10-26.md；归档模块 | tar.gz 格式结论与实验依据已吸收至 Q-008 和当前协议；Windows 私有归档专项通过 | 全量 GiB、峰值内存/功耗及 Java 互通仍待专项验证，见覆盖缺口 |
| 更换设备后的 SAF 复测 | completed | testing/regression-notes.md、testing/test-cases.md | apps/mobile 原生仪器测试 | API 33 合成夹具的读取、选择/取消、重启恢复回执完整；内容/mtime 一致；重复读取完整快照一致 | 首次访问 ctime 变化归因、API 29/其它提供者仍待验证；旧 API 35 真实目录证据不迁移 |
| 实现 WP-003 Android SAF 读取适配 | completed | development/work-packages.md、testing/coverage-gaps.md | apps/mobile Java 插件、TS 桥与测试 | 只读授权/恢复、当前层元数据及原生流已实现；桥、Java 单元、lint/双 APK 及 API 33/35 读取验证通过 | API 29/其它提供者、实际撤权/目录移除与传输生命周期仍待验证；写入由 WP-010 承接 |
| 实现 WP-002 Windows 目录读取适配 | completed | development/work-packages.md、testing/coverage-gaps.md | apps/desktop 目录适配、preload 与测试 | 目录配置恢复、当前层元数据、根内只读流和有限 IPC 已实现；16 项目录/IPC、构建隔离加载与真实目录只读检查通过 | WP-007 补系统选择器及最终界面人工验收；WP-009 已实现原生新文件发布；真实存档保持只读 |

开始产品、代码或文档工作前登记范围、入口和下一步；检查点、阻塞和完成时更新。Git 暂存、提交、reset 等操作不作为独立工作项登记。完成时先更新长期事实，再记录完成状态与结果；完成状态进入 Git 历史后，后续维护才可清理无缺口的工作项。开放问题保留结论和状态。

## 3. 按需路由

| 任务信号 | 首选目录 | 说明 |
| --- | --- | --- |
| 目标、术语、路线图 | `project/` | 读取命中的当前章节 |
| 需求、范围、约束 | `requirements/` | 以当前表述和开放问题为准 |
| 当前架构、接口、数据流、决策 | `architecture/`、`decisions/` | 先看事实，再按需看决策理由 |
| 实现、模块、代码地图 | `development/` | 关注当前状态、入口和工作包 |
| 代码实现或代码测试 | 项目规范、通用编码规则和匹配语言规则 | 只读取与目标文件匹配的规范 |
| 测试策略、用例、验收 | `testing/`、`standards/testing-style.md` | 按当前验证范围选择章节 |
| 风险、问题、依赖 | `governance/` | 只保留仍开放或仍有效的项 |
| Git 提交 | `standards/commit-style.md` | 需要提交时读取 |

## 文档目录

| 文档 | 标题 | 状态 | 标签 |
| --- | --- | --- | --- |
| `architecture/api-contracts.md` | 接口契约 | active | API, 接口契约 |
| `architecture/data-flow.md` | 数据流 | draft | 数据流 |
| `architecture/dependencies.md` | 架构依赖 | draft | 依赖 |
| `architecture/modules.md` | 模块设计 | draft | 模块 |
| `architecture/overview.md` | 架构总览 | active | 架构总览 |
| `development/code-map.md` | 代码地图 | active | 代码地图 |
| `development/implementation-notes.md` | 实现细节 | active | 实现细节 |
| `development/known-issues.md` | 已知问题 | active | 已知问题 |
| `development/module-status.md` | 模块状态 | active | 模块状态, 开发进度 |
| `development/work-packages.md` | 工作包登记 | active | 工作包, M-001, 设计 |
| `governance/assumptions.md` | 项目假设 | active | 假设 |
| `governance/dependencies.md` | 外部依赖 | active | 外部依赖 |
| `governance/issues.md` | 问题登记表 | active | 问题 |
| `governance/risks.md` | 风险登记表 | active | 风险 |
| `project/charter.md` | 项目章程 | active | 项目目标, 成功标准 |
| `project/glossary.md` | 项目术语表 | draft | 术语 |
| `project/roadmap.md` | 项目路线图 | active | 路线图, 里程碑 |
| `project/stakeholders.md` | 干系人与角色 | draft | 干系人, 角色 |
| `requirements/change-requests.md` | 变更请求 | active | 变更请求 |
| `requirements/constraints.md` | 项目约束 | active | 约束 |
| `requirements/open-questions.md` | 开放问题 | active | 开放问题 |
| `requirements/product.md` | 产品需求 | active | 产品需求 |
| `requirements/scope.md` | 项目范围 | active | 范围 |
| `requirements/user-stories.md` | 用户故事 | draft | 用户故事 |
| `standards/api-style.md` | API 规范 | draft | API规范 |
| `standards/coding-style.md` | 项目级编码规范 | active | 编码规范 |
| `standards/commit-style.md` | 提交规范 | active | 提交规范 |
| `standards/testing-style.md` | 测试规范 | draft | 测试规范 |
| `testing/acceptance.md` | 验收标准 | active | 验收标准 |
| `testing/coverage-gaps.md` | 测试覆盖缺口 | active | 测试缺口 |
| `testing/regression-notes.md` | 当前回归状态 | active | 回归测试, 当前状态 |
| `testing/strategy.md` | 测试策略 | draft | 测试策略 |
| `testing/test-cases.md` | 测试用例 | active | 测试用例 |
