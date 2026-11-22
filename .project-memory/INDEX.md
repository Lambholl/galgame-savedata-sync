---
doc_type: index
status: active
updated: 2026-11-23
tags: [索引]
---

# 项目记忆索引

## 目录

- [当前工作](#当前工作)
- [按任务查找](#按任务查找)
- [文档目录](#文档目录)

## 当前工作

| 工作 | 状态 | 相关记忆文档 | 相关代码或配置 | 已完成 | 下一步 |
| --- | --- | --- | --- | --- | --- |

## 按任务查找

| 任务 | 先读 |
| --- | --- |
| 目标、术语、路线图 | `project/` |
| 需求、范围、约束、开放问题 | `requirements/` |
| 架构、接口、数据流、决定 | `architecture/`、`decisions/` |
| 改某一端的平台代码 | `architecture/windows.md`、`architecture/android.md`、`architecture/shared-package.md` |
| 实现、代码位置、已知问题、风险 | `development/` |
| 写或改代码 | `standards/coding.md`，以及 `development/code-map.md` 里相关路径的约定 |
| 改界面 | `development/ui-conventions.md` |
| 测试、验收 | `standards/testing.md`、`testing/` |
| 写文档 | `standards/writing.md`、`project/glossary.md` |
| 提交、发布 | `standards/commit.md` |

## 文档目录

| 文档 | 标题 | 状态 | 标签 |
| --- | --- | --- | --- |
| `architecture/android.md` | Android 平台层 | active | Android, 移动端, SAF, 原生插件 |
| `architecture/api-contracts.md` | 接口约定 | active | API, 接口约定 |
| `architecture/dependencies.md` | 架构依赖 | draft | 依赖 |
| `architecture/overview.md` | 架构总览 | active | 架构总览 |
| `architecture/shared-package.md` | 共享包 | active | 共享包, 数据模型, 守卫 |
| `architecture/sync-copy.md` | 复制、备份与恢复约定 | active | 复制, 备份, 恢复 |
| `architecture/transfer-protocol.md` | 设备接口与归档格式 | active | 设备接口, tar.gz, HTTP |
| `architecture/windows.md` | Windows 平台层 | active | Windows, 电脑端, Tauri, sidecar, 存储目录 |
| `decisions/ADR-0002-ui-library-and-shared-rendering.md` | ADR-0002 维持 antd 系列，抽取双端共用渲染 | accepted | 决策, 界面, 组件库, 共用组件 |
| `decisions/ADR-0003-android-direct-file-access.md` | ADR-0003 Android 所有文件访问权限与统一的文件访问接口 | accepted | 决策, Android, 文件访问, SAF, 所有文件访问权限 |
| `decisions/ADR-0004-symmetric-listener-dialer-roles.md` | ADR-0004 按监听方和拨号方划分连接与传输职责 | accepted | 决策, 连接, 传输, 监听方, 拨号方, Android, Windows |
| `decisions/ADR-0005-tauri-sidecar-and-storage-layout.md` | ADR-0005 电脑端改用 Tauri 宿主和 Node sidecar，重新规划存储目录 | accepted | 决策, 电脑端, Tauri, sidecar, 存储目录, 便携模式, 备份库 |
| `development/code-map.md` | 代码地图 | active | 代码地图 |
| `development/implementation-notes.md` | 实现细节 | active | 实现细节 |
| `development/known-issues.md` | 已知问题 | active | 已知问题 |
| `development/module-status.md` | 模块状态 | active | 模块状态, 开发进度 |
| `development/risks.md` | 风险登记表 | active | 风险 |
| `development/ui-conventions.md` | 界面约定 | active | 界面, 设计变量, 组件 |
| `development/work-packages.md` | 工作包登记 | active | 工作包 |
| `project/charter.md` | 项目章程 | active | 项目目标, 成功标准 |
| `project/glossary.md` | 项目术语表 | draft | 术语 |
| `project/roadmap.md` | 项目路线图 | active | 路线图, 里程碑 |
| `requirements/change-requests.md` | 变更请求 | active | 变更请求 |
| `requirements/constraints.md` | 项目约束 | active | 约束 |
| `requirements/open-questions.md` | 开放问题 | active | 开放问题 |
| `requirements/product.md` | 产品需求 | active | 产品需求 |
| `requirements/scope.md` | 项目范围 | active | 范围 |
| `standards/coding.md` | 编码约定 | active | 编码规范 |
| `standards/commit.md` | 提交约定 | active | 提交规范 |
| `standards/testing.md` | 测试约定 | active | 测试规范 |
| `standards/writing.md` | 写作约定 | active | 写作规范 |
| `testing/acceptance.md` | 验收标准 | active | 验收标准 |
| `testing/coverage-gaps.md` | 测试覆盖缺口 | active | 测试缺口 |
| `testing/regression-notes.md` | 当前回归状态 | active | 回归测试, 当前状态 |
| `testing/test-cases.md` | 测试用例 | active | 测试用例 |
