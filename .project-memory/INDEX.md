---
doc_type: index
status: active
owner: project
updated: 2026-10-29
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
| 双端应用替换占位 logo | done | development/implementation-notes.md、standards/commit-style.md | assets/app-logo.png、桌面品牌/HTML、Windows ICO/窗口与打包配置、Android drawable-nodpi/app_logo.png 与 Manifest/splash | Windows 侧栏 64×64、ICO/窗口/打包及网页图标已接入；Android 系统图标直接使用用户原 PNG，不额外留白或预裁圆形，页面保留文字标识。工程检查、Android 单元/lint/双 APK/归档互通、实际 Electron 明暗截图、APK 原图像素与网页资源核对通过；正式 APK 已安装，安装文件哈希与构建一致，手机应用信息页已核对 | 独立提交本次标识改动；用户查看手机图标效果，后续继续 WP-028 |
| 电脑游戏卡片统一为手机样式 | done | development/implementation-notes.md、standards/coding-style.md | desktop GamesPage/GameCard、desktop.css；参照 mobile GameCard/mobile.css | 已统一渐变/居中封面/底部信息与圆角，收窄为 160–180px，保留 152px 封面和 88px 起的信息区；实际构建的隐藏 Electron 截图已核对竖版尺寸、长标题与明暗主题，工程检查和编译通过 | 与 WP-027 一并提交；保留各端独立组件 |
| WP-027 Windows 计划、结果与本机恢复界面 | done | development/work-packages.md、architecture/api-contracts.md、testing/regression-notes.md、standards/commit-style.md | desktop renderer/备份与任务页、有限 bridge/preload/IPC、主进程同步与本机恢复 | 有限桥、异步恢复、备份/计划/结果与重扫已接入；实际文件/IPC 5 组、清理失败/部分/未知与新桥 4 组、实际 Electron/HTTP 的刷新找回任务/扫描未完成/确认恢复/重扫/取消/明暗截图 7 组通过；56 项既有 TS 检查、antd lint、pnpm check 与双端资源构建通过 | 整理并提交本包后先完成双端 logo 独立提交，再进入 WP-028；跨端发起保持 M-004；最后用户总体验收仍待执行 |
| WP-026 Windows → Android 复制编排 | done | development/work-packages.md、architecture/api-contracts.md、testing/regression-notes.md | Windows sync-registry/HTTP/source 归档、Android SyncTransferEngine/Runtime/Model、SyncWriter/BackupStore 及 TS bridge | 原生双向编排、API 33 实际 SAF/LAN 与正式插件/通知/后台接收/Activity 重建及新桥检查通过；原文与配置恢复、Windows 单次发送/期限及备份失败清理重试通过；写入器保持名额直到备份残留清理完成；临时源码/测试 APK 已清理，既有套件、工程与 Android lint/双 APK/互通、最终正式 APK 及资源一致性核对通过 | 下一包 WP-027 Windows 计划、结果与本机恢复界面 |
| WP-025 Android → Windows 复制编排 | done | development/work-packages.md、architecture/api-contracts.md、testing/regression-notes.md | shared sync jobs、Windows sync-registry/upload-body/写入/连接、Android SyncJobModel/SyncTransferEngine/Runtime/Plugin/Service、TS bridge | 该方向后端及有限桥已实现；API 33 实际 SAF/LAN、正式 Native 插件/真实及新实例 TS 桥、回执丢失/查询恢复/备份关闭/目标变化/实际取消、源及手机配置不变通过；JVM 故障与长源读取心跳通过；临时源码/测试 APK 已清理，既有套件、工程/Android lint/双 APK/归档互通及最终插件检查通过 | 下一包 WP-026 Windows → Android 复制编排 |
| WP-024 Android SAF 目录创建、受保护覆盖与恢复写入 | done | development/work-packages.md、architecture/api-contracts.md、testing/regression-notes.md | SyncPlanModel/Writer、SafSyncBackend、SyncWriteRuntime/Plugin、TargetOperation、TS sync-write bridge | 原生计划复核、保护后写入/恢复及有限桥已实现；API 33 实际 SAF 与恢复任务状态、JVM 故障/容量、共享守卫/TS 桥/正式插件及 Windows 末项成功后独立清理错误验证通过；临时源码已删除，既有套件、工程与 Android 检查/双 APK/归档互通通过 | 下一包 WP-025 Android → Windows 复制编排 |
| WP-023 Windows 目录创建、受保护覆盖与恢复写入 | done | development/work-packages.md、architecture/api-contracts.md、testing/regression-notes.md | sync-writer、sync-target-files、target-operation、扫描/目录适配/批次注册/启动 | 整批目标/原文复核、容量、保护后逐项发布及本机恢复已实现；实际合成目录、占用文件、故障/取消/超时/部分/未知结果、残留归属与互斥、33 项既有桌面回归及工程检查/双端构建通过；M-002 Android 10 实测已按用户要求移出验收 | 下一包 WP-024 Android SAF 受保护写入与恢复 |
| WP-022 Android 独立备份与轮换 | done | development/work-packages.md、architecture/api-contracts.md、testing/regression-notes.md、testing/coverage-gaps.md | Java 私有备份模型/存储/原生 IO、有限插件与 TS 桥 | 私有备份/设置/容量、三轮保留及恢复材料引用已实现；API 33 实际 SAF、独立原文哈希/源属性、进程重启、正式插件及 JVM 故障/桥检查通过；既有套件、工程检查和 Android 构建通过 | 下一包 WP-023 Windows 受保护写入/恢复；M-002 按用户要求不做 Android 10 实测 |
| 新增设备默认使用对端名称 | done | requirements/product.md、architecture/api-contracts.md、testing/regression-notes.md | http-service.ts、DeviceNames.java、HttpTransfersPlugin、双端设备保存逻辑 | Windows 使用系统计算机名，Android 优先系统设备名、取不到用型号；既有自定义名称保留。实际 HTTP/双端保存与重连、JVM 后备值/Unicode 限制、33 项桌面回归、工程检查和 Android 原生检查/双 APK/互通通过 | 继续 WP-022 Android 私有备份 |
| WP-021 Windows 独立备份与轮换 | done | development/work-packages.md、architecture/api-contracts.md、testing/regression-notes.md | backup-store/files/ipc、backup-bridge、directory-adapter、启动/preload | 私有备份/设置、提交和最近 3 次、恢复材料引用、容量与有限桥已实现；实际原文/源属性、新进程重启、故障/取消/超时/残留/链接保护与隔离验证通过；33 项既有桌面回归和工程构建通过 | 下一包 WP-022 Android 私有备份；实际恢复写回由 WP-023/WP-024 完成 |
| 连接状态按通信结果判断与统一 Message | done | requirements/product.md、architecture/api-contracts.md、testing/regression-notes.md | 双端 App、DesktopLibrary、移动 library-adapter/App | 复用元数据心跳，修正手机失联显示与空闲连接释放；断连回到未连接，antd message 提示一次，不诊断原因；手机连接失败也统一消息样式。受控失联/重连、活动上下文、实际页面明暗主题、工程检查、移动套件和 APK 构建通过 | 继续 WP-021 Windows 独立备份与轮换 |
| WP-020 Android SAF 当前扫描与内容指纹 | done | development/work-packages.md、architecture/api-contracts.md、testing/coverage-gaps.md | Android SyncScanner/SafSyncSource/SyncScansPlugin、移动 sync-scan bridge、既有目录/HTTP 插件与引擎 | 扫描与桥、实际 SAF 内容/源属性/取消、JVM 与桥针对性检查及既有套件和构建通过；前后台判断已移除。仅传输保活，普通操作切后台后的成败不作专项处理或验收 | 下一包 WP-021 Windows 独立备份与轮换；M-002 按用户要求不做 Android 10 实测 |
| WP-019 Windows 当前扫描与内容指纹 | done | development/work-packages.md、architecture/api-contracts.md | sync-scanner.ts、HTTP sync、service bridge/IPC、shared/sync | 已实现原生扫描、完整指纹及会话 HTTP/IPC；实际目录/源属性、源变化/越界、未知长度、预算/取消/超时关流/过期及桥边界通过；相关既有套件、工程检查和双端构建通过 | 下一步 WP-020：Java SAF 原生扫描、同一公开模型、有限插件/TS 桥及实际提供者验证 |
| WP-018 项目映射与手动连接补齐 | done | development/work-packages.md、architecture/api-contracts.md | apps/shared/src/library、apps/mobile/src/platform/library-adapter.ts、apps/desktop/src/main/library-* | 已补固定项目绑定、通知后目录复核、目录登记与活动任务编辑保护；桌面原生配置和移动适配层场景、全部既有 TS 套件、工程检查及双端/APK构建通过 | 下一步 WP-019：实现 Windows 当前递归扫描/哈希及受限扫描接口 |
| WP-017 共享扫描模型与纯比较计划 | done | development/work-packages.md、development/module-status.md、architecture/api-contracts.md | apps/shared/src/sync、apps/shared/src/index.ts、apps/shared/README.md | 模型、树/预算守卫、比较/恢复输入与逐项结果核对已实现；针对性运行和既有共享套件通过；已逐项运行等价工程检查并通过 | 下一步 WP-018：核实并补齐项目映射、重启恢复和手动改址的实际缺口 |
| WP-016 复制、备份与恢复详细约定 | done | development/work-packages.md、project/charter.md、architecture/api-contracts.md | docs/plans/m002-sync-copy.md | Windows 根隔离与 SAF 常规 FD 入口已调查；复制异常、私有备份/轮换/恢复、预算与新增协议已统一在第 3 节 | 下一步 WP-017：实现共享快照/计划/备份模型、守卫及纯比较规则 |
| M-002 工作包拆分与备份提前安排 | done | development/work-packages.md、project/roadmap.md、requirements/change-requests.md、testing/acceptance.md | docs/plans/m002-sync-copy.md；复用 shared、双端目录/归档/HTTP/发布及界面 | 已形成 WP-016 至 WP-029 共 14 包草稿，含范围/依赖/退出条件；CR-005 记录用户确认的备份提前，路线图/模块交接/验收已同步；记忆结构与格式检查通过 | 下一步 WP-016：细化并确认复制异常、协议兼容、备份位置/轮次/恢复规则，再按包进入实现 |
| 移除日常 CI 的安全审计 | done | development/code-map.md、development/implementation-notes.md、requirements/product.md、requirements/constraints.md、testing/regression-notes.md | .github/workflows/ci.yml、docs/development.md | 已删除 security:check 与 security:android 两个步骤，保留手动命令；开发说明与记忆已同步；YAML 格式、文本和记忆校验通过 | 新配置待远端 CI 复验；deepmerge 低危公告仍登记为手动审计问题 |
| WP-008 规模资源验证与 M-001 收尾，含 REQ-020 每次传输容量预检 | done | development/work-packages.md、requirements/product.md、testing/acceptance.md、testing/regression-notes.md、project/roadmap.md | 双端原生归档/HTTP/发布、docs/validation/m001-resources.md、.reports/wp008/ | 双向 1 GiB 成功，87.526/215.400 秒；原文/源属性/缓存核对通过；主进程采样峰值约 Windows 171 MiB、Android 232 MiB；容量预检、pnpm check、19 项 Windows 既有测试、android:test 通过，最新 APK 已安装；M-001 已收尾 | 下一步细化 M-002；覆盖/镜像/备份/发现及已登记恢复/文件系统缺口继续留后续范围 |

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
