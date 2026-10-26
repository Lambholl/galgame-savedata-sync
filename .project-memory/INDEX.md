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
| tar.gz 批量契约设计与拆包 | completed | architecture/api-contracts.md、architecture/modules.md、development/work-packages.md、testing/、project/roadmap.md | docs/plans/m001-directory-http.md、docs/plans/m001-tar-gzip-protocol.md、packages/shared/README.md；仅修改文档 | 清单/目标映射、v1 路由/会话、受限归档、资源/期限、进度/逐文件结果和取消设计已完成；用户确认无 HTTP 消费者，直接修订 v1；新增 WP-011/012/013 及 TC-023 至 TC-027；记忆、文本、87 个本地链接/章节、13 包依赖、预算与差异检查通过 | 下一实现包 WP-011 共享批量契约，无需 ADB；代码/测试尚未实现，新包仍 planned；真实存档保持只读，未提交 |
| 统一中文代码注释 | completed | standards/coding-style.md；Skill 通用编码规则 | 全仓库已跟踪源码、配置及文档代码块 | 已补充跨语言中文注释规则及适用范围，同步语言示例；仓库 29 个源码/配置文件完成翻译，复扫仅保留许可、指令、URL 与代码示例；去注释代码及 Python 去文档字符串 AST 一致；pnpm check、Android 单元/lint/调试与测试 APK、Skill 与记忆校验通过 | 未提交；后续修改继续遵循中文注释规则；Capacitor 同步会重生成两份配置的文件头，需按规则处理；项目自身许可证仍在讨论，未添加 |
| 修复 CI 桌面目录测试路径差异 | completed | testing/regression-notes.md、testing/test-cases.md、development/implementation-notes.md | apps/desktop/test 两套夹具及新增 temporary-paths.test.mjs、apps/desktop/README.md | 原默认 15 项通过；本机 8.3 短路径环境复现与 CI 相同的 9 项失败；夹具改用异步 realpath 临时根，正常/短路径均 16 项通过无跳过，pnpm check 通过；业务路径检查未放宽 | 本轮修复随获授权的本地提交进入 Git 历史；远端 CI 仍需重跑确认；不推送，不操作真实存档 |
| 确定 tar.gz 传输方案 | completed | requirements/open-questions.md、requirements/product.md、architecture/、development/work-packages.md、testing/、project/ | 本轮仅维护项目记忆 | 双向唯一 tar.gz 已登记为 REQ-018，Q-008 已关闭；已清理其他传输备选和格式未决表述，同步架构/工作包/路线图与正式契约缺口；记忆、文本及差异检查通过 | 批量契约与拆包设计已完成，下一实现起点为 WP-011；实验报告保留比较证据，不替代正式归档/HTTP/发布验收 |
| 小文件传输方式快速基准 | completed | requirements/open-questions.md、testing/regression-notes.md、testing/test-cases.md | debug SAF 授权 Activity、TransferBenchmarkTest、scripts/experiments/transfer-benchmark.py；docs/experiments/transfer-benchmark-2026-10-26.md/CSV | 三个真实只读样本双向比较实验共 54 组通过，包含 5,526 个 SAF 新建写后回读；每组 TCP 连接=1；原目录列表/内容/大小/mtime/身份一致；数据副本、服务与本轮写授权已清理；pnpm check、Java 单元/lint/双 APK、release Manifest 隔离与默认跳过检查通过 | 已据此确定唯一 tar.gz 方案，Q-008 已关闭；正式设计和 WP-011/012/013 拆包已完成，实现仍待推进，不将实验当作正式归档/写入/HTTP 验收 |
| 评估小文件归档传输 | completed | requirements/open-questions.md、architecture/api-contracts.md | 文档；正式 HTTP 尚未实现 | 评估与独立 LAN/SAF 性能实验已为 tar.gz 决定提供依据，结论见 Q-008 | 批量契约、资源预算和分包设计已完成，进入实现后补正式故障矩阵；峰值内存/功耗仍待实测 |
| 更换设备后的 SAF 复测 | completed | testing/regression-notes.md、testing/test-cases.md、development/work-packages.md | 既有 Java SAF 插件与仪器测试、调试/测试 APK；本轮仅更新验证文档 | API 33 已核对同版双 APK；6 项非交互及分别执行的 3 项交互全部通过，完整回执收齐；固定目标后 ADB 服务/transport 稳定；合成夹具原文/mtime 一致，首次差异仅 3 文件 ctime，后续重复读取完整快照一致；未访问旧存档路径 | 旧 API 35 真实目录证据仅适用旧机；API 29/其它提供者等缺口继续保留；测试夹具与只读授权留供复验；未改业务代码，未提交 |
| 实现 WP-003 Android SAF 读取适配 | completed | development/work-packages.md、architecture/api-contracts.md、testing/test-cases.md、standards/coding-style.md | apps/mobile Java 原生插件、TS 桥、测试及原生检查入口 | 已实现只读选择/恢复、当前层元数据与原生读流；5 项桥、4 项新增 Java 单元、pnpm check、原生 lint/双 APK 构建通过；API 35 选择/取消、进程重启授权/身份恢复及 11 文件只读验证通过；未使用 root，内容与修改时间保持一致 | 按已完成的批量设计先做 WP-011/WP-012，再进入 WP-004；写入留 WP-009/WP-010；API 29/其它提供者、实际撤权及传输生命周期缺口保留；ADB 间歇中断不作为通过证据 |
| 实现 WP-002 Windows 目录读取适配 | completed | development/work-packages.md、architecture/api-contracts.md、testing/test-cases.md | apps/desktop 主进程、preload、测试及根检查入口 | 已实现目录登记/配置恢复、当前层元数据、根内只读流和受限 IPC；15 项桌面测试、pnpm check、preload 隔离加载及真实 Windows 目录只读检查通过；分包依赖与记忆已同步；未保存机器路径或原始哈希 | 对应授权后进入 WP-003 Android SAF；WP-009 暂存发布先于 HTTP 接收；最终界面/原生选择器人工交互及 Android/HTTP 仍待验证；提交权限见章程，真实两端目录保持只读 |
| 实现 WP-001 共享模型与契约 | completed | development/work-packages.md、architecture/api-contracts.md、testing/test-cases.md、standards/coding-style.md | packages/shared、根 package.json、tsconfig.base.json、docs/plans/m001-directory-http.md | 版本 1 DTO、纯守卫、路由/头名/错误映射、线格式说明及示例已实现；15 项运行时测试、9 项类型反例与 pnpm check（含双端构建）通过；无新增依赖或平台 IO | 对应授权后进入 WP-002 Windows 目录适配；平台 IO/HTTP/真机验收仍待后续包；本次提交权限见章程 |

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
