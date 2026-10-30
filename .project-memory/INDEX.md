---
doc_type: index
status: active
owner: project
updated: 2026-10-31
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
| 电脑端发起覆盖复制与 WebSocket 控制通道（CR-012、CR-013，解决 BUG-005） | done | requirements/change-requests.md、development/known-issues.md、architecture/api-contracts.md | shared/src/control；desktop main control-hub/http-service/library-store/remote-sync-requests、sync-ipc/sync-bridge、RemoteSyncPanel；Android ControlClient/TransferEngine/HttpTransfersPlugin、build.gradle；移动 control-channel/library-adapter/use-remote-sync | 用户确认：手机开着并已连接即可，只在电脑确认，登记 CR-012。轮询版已实现并通过 pnpm check 与 android:build。真机试用发现：手机目录偶尔要手动刷新（重复读取同一层报 busy，已改为共用查询）；电脑不显示完成结果；轮询延迟大。用户选定改用 WebSocket 控制通道（CR-013）：两端同版、不保留轮询回退，电脑 ws、Android Java-WebSocket，并按以后任意两设备传输（REQ-022）对称设计。CR-013 已实现：`/v1/control` 承担目录读取、电脑发起、完成回报、目录表变化通知和心跳，轮询路由已删除；新增 ws 8.22.0、Java-WebSocket 1.6.0，OSV 无公告；pnpm check、antd lint、android:build 通过，控制中心本地连通检查通过，未提交。首轮真机：手机发起正常；电脑扫描完成后切换方向被“另一项扫描请求还在进行”挡住，已改为新扫描取代未确认的旧请求；手机 → 电脑总提示计划与项目不符，原因是计划的项目 ID 取目标一侧（电脑项目），电脑却按手机项目核对，已修正；只改电脑端，pnpm check 通过；用户复测通过。按用户意见，电脑改设备名不再通知手机，各端保留自己的命名 | 用户确认后提交并打 v0.1.1 标签推送，由 Release 工作流生成草稿发布 |
| Android 固定签名（BUG-006） | active | development/known-issues.md | apps/mobile/android/app/build.gradle、scripts/android-build.mjs、package.json android:release、.github/workflows/release.yml、docs/development.md、.gitignore | 用户选定私有密钥 + GitHub Secrets，Release 改发 release 包；签名配置、release 构建脚本、发布工作流与开发文档已改，用临时测试密钥验证构建；用户已生成正式密钥，本机 android:release 成功。补充 keystore.properties.example、自编译/fork/密钥丢失或泄露指引，发布工作流开头检查 Secrets，check-text 跳过本机 keystore.properties；未提交 | 用户配置四个 Secrets 后提交，下次发布验证 CI 产物可覆盖本机构建的包 |
| 双端界面与设置后续调整 | active | development/known-issues.md、requirements/change-requests.md、development/implementation-notes.md、standards/coding-style.md | 双端传输/计划/目录/备份界面、主题偏好、备份设置和文案资源 | 移动端已有双列浏览、独立同步计划页、页面动画、浮动操作和 Message，工程检查与移动测试通过。剩余缺陷记为 BUG-003 至 BUG-005，界面、主题、备份设置和 i18n 变更记为 CR-007 至 CR-011。BUG-003：原生 jobId 等于 planId，SyncTaskDetails 里结果和计划两个同级组件 key 相同，轮询时旧结果节点留在常驻页面容器里；key 加前缀区分后，2026-10-31 真机复核通过；版本号已升到 0.1.1（四个 package.json、Android versionName、versionCode 1→2、双端界面版本文字），release 版本检查、pnpm check 与 android:build 通过。BUG-004：用户确认场景是电脑→手机且计划含覆盖；当前调试包在 OPD2404 用独立桌面配置和合成目录走同一流程，备份正常创建并可列出，用户在原手机手动复测也正常，按不可复现关闭。原手机装的还是 10-29 的包，结果重复是没有 BUG-003 修复的旧包现象。BUG-005 由 CR-012 处理 | 原手机安装新包后复核 BUG-003（adb 断开后不得重连，需用户手动安装）；清理平板测试游戏/授权/备份与 Download/GSS-Repro 及桌面临时配置；再做两端界面重构，最后处理主题/备份策略/i18n |

开始产品、代码或文档工作前登记范围、入口和下一步；检查点、阻塞和完成时更新。完成时先更新长期事实，再记录完成状态与结果。

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
| `development/work-packages.md` | 工作包登记 | active | 工作包, M-001, M-002, 设计 |
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
