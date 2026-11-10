---
doc_type: index
status: active
updated: 2026-11-10
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
3. 任务范围变化时重新查看导航；规范或路径不明确时先调查再写入。

## 2. 当前工作

| 工作 | 状态 | 相关记忆文档 | 相关代码或配置 | 已完成 | 下一步 |
| --- | --- | --- | --- | --- | --- |

开始产品、代码或文档工作前登记范围、入口和下一步；检查点和阻塞时更新。做完并验证后先更新长期事实，再把状态改为 `in-review`；有新修改时改回 `active`，维护者验收后才删除该行。

## 3. 按需路由

| 任务信号 | 首选目录 | 说明 |
| --- | --- | --- |
| 目标、术语、路线图 | `project/` | 读取命中的当前章节 |
| 需求、范围、约束 | `requirements/` | 以当前表述和开放问题为准 |
| 当前架构、接口、数据流、决策 | `architecture/`、`decisions/` | 先看事实，再按需看决策理由 |
| 实现、模块、代码地图、已知问题、风险 | `development/` | 关注当前状态、入口和工作包；问题和风险只保留仍开放的项 |
| 代码实现或代码测试 | 项目规范、通用编码规则和匹配语言规则 | 只读取与目标文件匹配的规范 |
| 测试规则、用例、验收 | `testing/`、`standards/testing-style.md` | 按当前验证范围选择章节 |
| Git 提交 | `standards/commit-style.md` | 需要提交时读取 |

## 文档目录

| 文档 | 标题 | 状态 | 标签 |
| --- | --- | --- | --- |
| `architecture/api-contracts.md` | 接口约定 | active | API, 接口约定 |
| `architecture/dependencies.md` | 架构依赖 | draft | 依赖 |
| `architecture/overview.md` | 架构总览 | active | 架构总览 |
| `decisions/ADR-0002-ui-library-and-shared-rendering.md` | ADR-0002 维持 antd 系列，抽取双端共用渲染 | accepted | 决策, 界面, 组件库, 共用组件 |
| `development/code-map.md` | 代码地图 | active | 代码地图 |
| `development/implementation-notes.md` | 实现细节 | active | 实现细节 |
| `development/known-issues.md` | 已知问题 | active | 已知问题 |
| `development/module-status.md` | 模块状态 | active | 模块状态, 开发进度 |
| `development/risks.md` | 风险登记表 | active | 风险 |
| `development/work-packages.md` | 工作包登记 | active | 工作包, M-002, M-003, 验收 |
| `project/charter.md` | 项目章程 | active | 项目目标, 成功标准 |
| `project/glossary.md` | 项目术语表 | draft | 术语 |
| `project/roadmap.md` | 项目路线图 | active | 路线图, 里程碑 |
| `requirements/change-requests.md` | 变更请求 | active | 变更请求 |
| `requirements/constraints.md` | 项目约束 | active | 约束 |
| `requirements/open-questions.md` | 开放问题 | active | 开放问题 |
| `requirements/product.md` | 产品需求 | active | 产品需求 |
| `requirements/scope.md` | 项目范围 | active | 范围 |
| `standards/coding-style.md` | 项目级编码规范 | active | 编码规范 |
| `standards/commit-style.md` | 提交规范 | active | 提交规范 |
| `standards/testing-style.md` | 测试规范 | active | 测试规范 |
| `testing/acceptance.md` | 验收标准 | active | 验收标准 |
| `testing/coverage-gaps.md` | 测试覆盖缺口 | active | 测试缺口 |
| `testing/regression-notes.md` | 当前回归状态 | active | 回归测试, 当前状态 |
| `testing/test-cases.md` | 测试用例 | active | 测试用例 |
