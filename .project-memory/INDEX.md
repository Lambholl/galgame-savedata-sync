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
| 整理并验证 M-001 设计提交 | completed | project/charter.md、standards/commit-style.md、development/work-packages.md | docs/plans/m001-directory-http.md、M-001 相关项目记忆 | 已核对单次本地提交授权及 12 个文档/记忆文件的范围；授权边界已同步，记忆、文本和差异检查通过，无业务代码变更 | 按本次单次授权创建包含本行的本地提交；提交成功后授权自动耗尽，不推送 |
| 设计 M-001 并拆分后续工作 | completed | project/roadmap.md、architecture/api-contracts.md、architecture/modules.md、development/work-packages.md、testing/test-cases.md | docs/plans/m001-directory-http.md；后续涉及 packages/shared、apps/desktop、apps/mobile | 已形成 8 个候选工作包、接口/模块边界、14 个待执行用例及后续交接；已同步 CI 通过与授权；记忆、设计链接、文本和差异校验通过 | 设计文档完成，候选方案仍待评审；下一包为 WP-001，共用契约确认并获对应实现授权后开工；同步业务尚未实现 |
| 精简项目记忆 | completed | project/、development/、testing/、governance/dependencies.md | 文档 | 已删除机器环境记录及重复表述，开发指南保留通用说明 | 按路线图继续项目工作 |
| 整理首次提交 | completed | project/charter.md、standards/commit-style.md | 仓库全部源文件与配置 | 已更新授权记录并核对提交范围，仓库检查及记忆校验通过 | 按路线图继续项目工作 |
| 修复干净检出的 Android 审计 | completed | development/code-map.md、testing/regression-notes.md | package.json、docs/development.md | 修复已随工程规范提交落库；本地干净副本审计通过，用户已确认远端 CI 通过 | 已闭环，后续维护保留干净检出检查 |
| 按通用编码规范完善 ESLint | completed | standards/coding-style.md、testing/regression-notes.md | eslint.config.mjs、.prettierrc.json、.prettierignore、package.json、pnpm-lock.yaml、手写 TS/JS | 已补齐质量和命名规则、框架默认导出例外；ESLint 直接读取无分号 Prettier 配置，排除全部 Markdown；pnpm check、规则反例、格式冲突和依赖审计通过，规范与验证边界已同步 | 后续修改共用 Prettier 配置；按项目流程继续集成 |
| 建立 Agent 开发准入规则 | completed | standards/coding-style.md | AGENTS.md、apps/AGENTS.md | 已创建根目录简短门槛与 apps 细则，要求开发前具备并读取 antd skill；已明确主动读取子目录规则及双端组件库边界，文本、链接和记忆校验通过 | 后续 Agent 开发遵循根入口；应用开发按需读取 apps 细则 |
| 明确 Git 提交授权边界 | completed | standards/commit-style.md、project/charter.md | AGENTS.md | 已落实明确授权与默认单次规则、范围和失效边界，清除章程中的旧提交授权；记忆、文本及差异校验通过，本轮未暂存或提交 | 后续提交前核对用户授权来源、范围及有效性，单次授权耗尽后重新取得授权 |
| 整理并验证工程规范提交 | completed | project/charter.md、standards/commit-style.md、testing/regression-notes.md | ESLint、Prettier、Agent 规则、Android 审计入口及相关源码和文档 | 已创建本地提交 dc29348；提交前工程检查通过，用户已确认远端 CI 通过 | 原单次提交授权已耗尽；后续提交须另有明确授权 |

开始产品、代码或文档工作前登记范围、入口和下一步；检查点、阻塞和完成时更新。完成时先更新长期事实，再记录完成状态与结果；完成状态进入 Git 历史后，后续维护才可清理无缺口的工作项。开放问题保留结论和状态。

## 3. 按需路由

| 任务信号 | 首选目录 | 说明 |
| --- | --- | --- |
| 目标、术语、路线图 | `project/` | 读取命中的当前章节 |
| 需求、范围、约束 | `requirements/` | 以当前表述和开放问题为准 |
| 当前架构、接口、数据流、决策 | `architecture/`、`decisions/` | 先看事实，再按需看决策理由 |
| 实现、模块、代码地图 | `development/` | 关注当前状态、入口和工作包 |
| 代码实现或代码测试 | 项目规范、公司通用规则和匹配语言规则 | 只读取与目标文件匹配的规范 |
| 测试策略、用例、验收 | `testing/`、`standards/testing-style.md` | 按当前验证范围选择章节 |
| 风险、问题、依赖 | `governance/` | 只保留仍开放或仍有效的项 |
| Git 提交 | `standards/commit-style.md` | 需要提交时读取 |

## 文档目录

| 文档 | 标题 | 状态 | 标签 |
| --- | --- | --- | --- |
| `architecture/api-contracts.md` | 接口契约 | draft | API, 接口契约 |
| `architecture/data-flow.md` | 数据流 | draft | 数据流 |
| `architecture/dependencies.md` | 架构依赖 | draft | 依赖 |
| `architecture/modules.md` | 模块设计 | draft | 模块 |
| `architecture/overview.md` | 架构总览 | active | 架构总览 |
| `development/code-map.md` | 代码地图 | active | 代码地图 |
| `development/implementation-notes.md` | 实现细节 | active | 实现细节 |
| `development/known-issues.md` | 已知问题 | active | 已知问题 |
| `development/module-status.md` | 模块状态 | active | 模块状态, 开发进度 |
| `development/work-packages.md` | 工作包登记 | draft | 工作包, M-001, 设计 |
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
