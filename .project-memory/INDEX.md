---
doc_type: index
status: active
updated: 2026-11-13
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
| 传输流程精简（CR-024）：比较改用大小和修改日期，去掉 SHA-256，备份与传输并行，流式收发后统一替换 | active | `requirements/change-requests.md`（CR-024）、`requirements/product.md`（REQ-015、REQ-018、REQ-020）、`architecture/overview.md`、`architecture/api-contracts.md`、`development/implementation-notes.md`、`docs/plans/m001-tar-gzip-protocol.md` | `apps/shared/src/sync/`、`apps/shared/src/protocol/`、`apps/desktop/src/main/`（sync-scanner、archive-adapter、sync-registry、sync-writer、backup-store）、Android `SyncScanner`、`ArchiveAdapter`、`SyncTransferEngine`、`SyncWriter`、`BackupStore` | A：比较改用大小和修改日期，计划和扫描去掉 SHA-256。B：两端边读边打包发送、边收边解包到私有目录，去掉清单提交和压缩包落盘，协议能力版本 6、任务结构版本 4，两端打包格式互相解包已用临时测试核对。C：接收端登记后写入器立即核对目标并备份，内容可在备份期间上传或下载；备份完成后等内容到齐，重新核对目标列表再写入；进度为备份、传输、写入三段。一端先失败时停下另一端。`pnpm check`、shared/desktop/Android 单元测试通过；电脑端写入器和接收流程的并行、目标在等待期间被改动、内容损坏、写入器先失败四种情况已用临时测试核对，Android 接收端的并行只经过编译和代码审阅 | 同步需求、架构、接口文档和测试用例；真机验证两个方向，重点看 Android 接收时的并行备份和失败收尾 |

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
| `decisions/ADR-0003-android-direct-file-access.md` | ADR-0003 Android 所有文件访问权限与统一的文件访问接口 | accepted | 决策, Android, 文件访问, SAF, 所有文件访问权限 |
| `development/code-map.md` | 代码地图 | active | 代码地图 |
| `development/implementation-notes.md` | 实现细节 | active | 实现细节 |
| `development/known-issues.md` | 已知问题 | active | 已知问题 |
| `development/module-status.md` | 模块状态 | active | 模块状态, 开发进度 |
| `development/risks.md` | 风险登记表 | active | 风险 |
| `development/work-packages.md` | 工作包登记 | active | 工作包 |
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
