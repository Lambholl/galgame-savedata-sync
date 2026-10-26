---
doc_type: index
status: active
owner: project
updated: 2026-10-27
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

本文件提供导航、可恢复当前工作和当前文档清单，不复制项目正文。`archive/` 不进入本索引或默认搜索。完成工作由 Git 保存，INDEX 只保留仍在进行或需要接续的事项。

## 2. 当前工作

| 工作 | 状态 | 相关记忆文档 | 相关代码或配置 | 已完成 | 下一步 |
| --- | --- | --- | --- | --- | --- |
| WP-014 / WP-015 双端 UI 实现 | implemented | development/work-packages.md、architecture/api-contracts.md、development/module-status.md | packages/ui、双端 library-adapter、桌面 library-bridge/main、Android TransferEngine/Plugin、docs/plans/ui-library.md | 正式界面、游戏/设备配置、单连接限制、目录元数据与原生传输已接入；先前工程/antd/56 项既有 JS 测试和依赖审计通过。用户要求自行验收后停止额外检查；最新 pnpm build、android:build 成功，APK 已通过 adb install -r 更新安装 | 用户运行验收；覆盖/删除/备份恢复按后续里程碑开放 |
| WP-007 最小验证界面 | completed | development/work-packages.md、development/module-status.md、architecture/api-contracts.md、testing/test-cases.md、testing/coverage-gaps.md | apps/desktop/src、apps/mobile/src、TransferEngine.java、双端 README | 双端目录/连接/传输与结果界面完成；桌面服务/接收授权桥完成；修正清单前终态、连接时目标丢失、子目录刷新和结果保留；实际 Windows 选择器、正常启动、API 33 LAN 双向与 SHA-256、冲突、取消/清理、页面重载和 64 MiB 后台上传通过；pnpm check、antd、既有桌面/移动套件、Android 单元/lint/双 APK/互通、记忆校验通过；说明与记忆已同步，用户已授权本地提交 | 下一项 WP-008：Android 10/较新系统与其它提供者组合、规模资源和 M-001 总体验收 |
| 按 humanizer-zh 清理文档表达 | completed | 全部项目记忆文档、architecture/api-contracts.md、development/*、testing/*、standards/testing-style.md | README.md、docs/**、apps/*/README.md、packages/shared/README.md、.project-memory/** | 清理用户说明、设计文档和项目记忆中的防御性声明、状态播报及工程套话；保留真实限制；`pnpm check`、项目记忆校验、本地 Markdown 链接检查和 `git diff --check` 通过 | 后续文档按 humanizer-zh 维护 |
| 精简测试并重写测试规范 | completed | standards/testing-style.md、testing/strategy.md、testing/test-cases.md、testing/regression-notes.md、testing/coverage-gaps.md | package.json、.github/workflows/ci.yml、各包测试目录、README 与开发文档 | 删除界面、实验、模板和重复故障场景，长期套件只保留稳定边界；`pnpm check` 改为静态检查与构建，新增发布用 `pnpm test:all`，CI 改用 `android:build`；`pnpm check`、三个最小 JS 套件、Android 既有检查、记忆校验和本地 Markdown 链接检查通过 | 后续功能按新测试规范执行 |

开始产品、代码或文档工作前登记范围、入口和下一步；检查点、阻塞和完成时更新。Git 暂存、提交、reset 等操作不作为独立工作项登记。完成时先更新长期事实，再记录完成状态与结果。

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
| `architecture/api-contracts.md` | 接口约定 | active | API, 接口约定 |
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
| `standards/chinese-commit-conventions.md` | 中文 Git 提交规范 | unspecified | - |
| `standards/coding-style.md` | 项目级编码规范 | active | 编码规范 |
| `standards/commit-style.md` | 提交规范 | active | 提交规范 |
| `standards/testing-style.md` | 测试规范 | active | 测试规范 |
| `testing/acceptance.md` | 验收标准 | active | 验收标准 |
| `testing/coverage-gaps.md` | 测试覆盖缺口 | active | 测试缺口 |
| `testing/regression-notes.md` | 当前回归状态 | active | 回归测试, 当前状态 |
| `testing/strategy.md` | 测试策略 | active | 测试策略 |
| `testing/test-cases.md` | 测试用例 | active | 测试用例 |
