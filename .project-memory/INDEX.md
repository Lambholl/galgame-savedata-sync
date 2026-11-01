---
doc_type: index
status: active
owner: project
updated: 2026-11-01
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
| 移动端 Stepper 恢复官方样式 | done | development/implementation-notes.md、standards/coding-style.md | apps/mobile/src/styles/mobile.css、components/BackupPolicyFields.tsx | 已排除 Stepper 内部 Input 与 input 元素的普通输入框样式覆盖，恢复官方 28px 原生外观。同版本官方组件在相同主题下的明暗尺寸、颜色、边框比较一致；1–10 边界、加减与直接输入通过，普通输入框样式正常。pnpm check 与 Android 构建通过 | 修正完成 |
| 界面文字选择与提示布局修正 | done | development/implementation-notes.md、standards/coding-style.md | shared/ui 文本选择与 ErrorText 样式、双端 SettingsPage/DevicesPage/App、desktop.css/mobile.css、shared library/i18n | 普通界面标签禁选，错误、路径/文件名、输入框、地址与版本值保留复制；错误图标/重试首行对齐，详情独立控制间距；桌面设备名与标签同行。连接地址显示、编辑和复制省略 http://，四语言占位统一 IP:Port，内部地址格式保持一致。pnpm check、共享 25/移动 7 项、6 个桌面文件 antd lint 和 Android 构建通过；双端浏览器实际拖选、复制粘贴、地址与布局核对通过 | 修正完成 |
| UI 改版 v2 四语言文案与 Android 通知 | done | requirements/change-requests.md（CR-011）、development/implementation-notes.md、standards/coding-style.md、testing/regression-notes.md | 双端 app/components/features/platform、shared i18n/result/ui、desktop main、Android Java/res | 四语言界面、窗口/选择器标题、错误码主提示与英文原文详情完成；后端自有错误统一英文，Android 通知与 app_name 四语言资源完成并读取已存语言。共用参数已导出注释，桌面长日语名称会换行。pnpm check、共享 25/桌面 33/移动 7 项、60 个桌面文件 antd lint、Android 构建/27 项单元/lint/测试 APK 通过，双端四语言浏览器与 APK 资源检查通过，中日文字面量扫描无残留 | 第 9 步完成；通知语言切换尚需手动真机复核，本轮未连接 adb；项目总体验收仍按原登记继续 |
| 电脑端发起覆盖复制与 WebSocket 控制通道（CR-012、CR-013，解决 BUG-005） | done | requirements/change-requests.md、development/known-issues.md、architecture/api-contracts.md | shared/src/control；desktop main control-hub/http-service/library-store/remote-sync-requests、sync-ipc/sync-bridge、RemoteSyncPanel；Android ControlClient/TransferEngine/HttpTransfersPlugin、build.gradle；移动 control-channel/library-adapter/use-remote-sync | 用户确认：手机开着并已连接即可，只在电脑确认，登记 CR-012。轮询版已实现并通过 pnpm check 与 android:build。真机试用发现：手机目录偶尔要手动刷新（重复读取同一层报 busy，已改为共用查询）；电脑不显示完成结果；轮询延迟大。用户选定改用 WebSocket 控制通道（CR-013）：两端同版、不保留轮询回退，电脑 ws、Android Java-WebSocket，并按以后任意两设备传输（REQ-022）对称设计。CR-013 已实现：`/v1/control` 承担目录读取、电脑发起、完成回报、目录表变化通知和心跳，轮询路由已删除；新增 ws 8.22.0、Java-WebSocket 1.6.0，OSV 无公告；pnpm check、antd lint、android:build 通过，控制中心本地连通检查通过，未提交。首轮真机：手机发起正常；电脑扫描完成后切换方向被“另一项扫描请求还在进行”挡住，已改为新扫描取代未确认的旧请求；手机 → 电脑总提示计划与项目不符，原因是计划的项目 ID 取目标一侧（电脑项目），电脑却按手机项目核对，已修正；只改电脑端，pnpm check 通过；用户复测通过。按用户意见，电脑改设备名不再通知手机，各端保留自己的命名 | 用户确认后提交并打 v0.1.1 标签推送，由 Release 工作流生成草稿发布 |
| Android 固定签名（BUG-006） | active | development/known-issues.md | apps/mobile/android/app/build.gradle、scripts/android-build.mjs、package.json android:release、.github/workflows/release.yml、docs/development.md、.gitignore | 用户选定私有密钥 + GitHub Secrets，Release 改发 release 包；签名配置、release 构建脚本、发布工作流与开发文档已改，用临时测试密钥验证构建；用户已生成正式密钥，本机 android:release 成功。补充 keystore.properties.example、自编译/fork/密钥丢失或泄露指引，发布工作流开头检查 Secrets，check-text 跳过本机 keystore.properties；未提交 | 用户配置四个 Secrets 后提交，下次发布验证 CI 产物可覆盖本机构建的包 |
| 双端界面与设置后续调整 | active | development/known-issues.md、requirements/change-requests.md、development/implementation-notes.md、standards/coding-style.md | 双端传输/计划/目录/备份界面、主题偏好、备份设置和文案资源 | 移动端已有双列浏览、独立同步计划页、页面动画、浮动操作和 Message，工程检查与移动测试通过。剩余缺陷记为 BUG-003 至 BUG-005，界面、主题、备份设置和 i18n 变更记为 CR-007 至 CR-011。BUG-003：原生 jobId 等于 planId，SyncTaskDetails 里结果和计划两个同级组件 key 相同，轮询时旧结果节点留在常驻页面容器里；key 加前缀区分后，2026-10-31 真机复核通过；版本号已升到 0.1.1（四个 package.json、Android versionName、versionCode 1→2、双端界面版本文字），release 版本检查、pnpm check 与 android:build 通过。BUG-004：用户确认场景是电脑→手机且计划含覆盖；当前调试包在 OPD2404 用独立桌面配置和合成目录走同一流程，备份正常创建并可列出，用户在原手机手动复测也正常，按不可复现关闭。原手机装的还是 10-29 的包，结果重复是没有 BUG-003 修复的旧包现象。BUG-005 由 CR-012 处理。2026-11-01 用户授权开始界面重构并允许本会话自行提交；第 1 批完成 ADR-0002 基础：shared 增加 `./ui` 导出与 react peer 依赖、src/ui 独立 tsconfig、ESLint 主入口/ui 入口边界与 Props 不透传规则（已用违规样例确认会报错），新增 PathText 并替换双端路径显示修复 BUG-007；pnpm check 通过，电脑主进程产物不含 React | 原手机安装新包后复核 BUG-003（adb 断开后不得重连，需用户手动安装）；清理平板测试游戏/授权/备份与 Download/GSS-Repro 及桌面临时配置；界面重构下一批：共用设计变量（颜色、圆角，同步给两端 ConfigProvider）与文件类型识别/FileTypeIcon，再按 CR-007/CR-008 重做手机传输与计划页；最后处理主题/备份策略/i18n |
| 双端 UI 审视与重设计原型（CR-007 至 CR-011） | done | requirements/change-requests.md、requirements/product.md、decisions/ADR-0002-ui-library-and-shared-rendering.md、standards/coding-style.md、development/known-issues.md | 原型 v2 只留本地 docs/design/ui-redesign-v2/（Git 忽略）；参照双端 features/* 现有页面 | 原型 v2 完成（手机 7 页、电脑 5 页、审视结论、设计语言、统一用语、已确认选择），浏览器渲染检查通过，未改应用代码。用户认可方向，原型选择 1–7 全部按建议确认并写入 CR-007 至 CR-011；REQ-015 改为全局与游戏单独设置、保留 1–10 份默认 3，REQ-019 加手动主题。路径换行登记为 BUG-007。i18n 扩为 zh-CN/zh-TW/en-US/ja-JP，与界面重构一起落地，主进程与原生层写死的中文提示需改为错误码。组件库维持 antd，共用渲染放 `@savedata-sync/shared/ui`（ADR-0002 accepted），共用组件 Props 全部导出、写明用途、不透传样式参数（编码规范“共用界面组件参数”） | 设计阶段结束；实现转入“双端界面与设置后续调整”：先按 ADR-0002 调整 shared 导出、JSX 配置与 ESLint 边界，再分批重构页面；正式编码前需用户授权实现范围 |

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
| `decisions/ADR-0002-ui-library-and-shared-rendering.md` | ADR-0002 维持 antd 系列，抽取双端共用渲染 | accepted | 决策, 界面, 组件库, 共用组件 |
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
