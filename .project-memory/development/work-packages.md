---
doc_type: work-packages
status: active
priority: high
owner: development
id_prefix: WP
id_high_water: 13
updated: 2026-10-26
tags: [工作包, M-001, 设计]
related_files:
  - docs/plans/m001-directory-http.md
  - docs/plans/m001-tar-gzip-protocol.md
---

# 工作包登记

## 目录

- [1. 状态与入口](#1-状态与入口)
- [2. M-001 工作包](#2-m-001-工作包)
- [3. 执行与拆分规则](#3-执行与拆分规则)

## 1. 状态与入口

前置双端归档、主题及 SAF 发布已提交，最新发布提交为 ebdd0f0。WP-006 Android HTTP 与持续通知保持传输已经完成，代码、说明和记忆同步完毕；独立 SAF、实际 LAN 双向、通知/后台继续、Activity 重建与显式取消验证也已完成。用户最新测试策略默认不新增或扩写自动化测试；后续功能用 lint、编译、ADB 实操和截图验证。写入只使用明确授权的独立目标夹具，真实存档保持只读；本轮不包含最终界面、覆盖/删除同步或推送。

详细范围与流程位于 `docs/plans/m001-directory-http.md`；[接口约定](../architecture/api-contracts.md)与[模块设计](../architecture/modules.md)维护当前边界。共享与平台说明见 `packages/shared/README.md`、`apps/desktop/README.md`、`apps/mobile/README.md`。基础设施、本地/批量共享模型、双端目录读取及 Windows 私有归档已经可用；Java SAF 的 API 33 合成夹具与 API 35 真实目录证据分别适用。Windows HTTP sender/receiver 及批次新文件发布可用；Android SAF 单文件发布完成实际 API 33 验证；Android HTTP/任务与持续通知可用；最终界面与同步流程还没完成；桌面测试路径修复仍待远端 CI 复验。

双向唯一 tar.gz 方案见[Q-008](../requirements/open-questions.md)，详细设计位于仓库根目录的 `docs/plans/m001-tar-gzip-protocol.md`。共享批量模型、双端私有归档、Windows HTTP sender/receiver 和非覆盖发布已经可用；WP-013 连同实际 API 33 SAF 集成、JVM/设备与 Windows 原生互通验证一起完成。WP-010 连同实际系统 WRITE/SAF、取消/清理重试与已有文件保护验证完成；WP-006 正式 LAN 与通知保持传输通过 TC-035；下一实现起点是 WP-007 最小验证界面。planned 项还未获实现授权，也未检查通过。表中保留仍有实现或验证交接的工作包；共享模型的当前事实见[模块状态](module-status.md)和[接口约定](../architecture/api-contracts.md)，最大已用编号保持 13。

## 2. M-001 工作包

| ID | 工作包 | 依赖 | 代码范围 | 退出条件与验证 | 状态 | 已完成 / 下一步 |
| --- | --- | --- | --- | --- | --- | --- |
| WP-002 | Windows 目录读取适配 | 共享本地模型 | apps/desktop 主进程、preload 与最小回归 | 目录引用持久化、当前层元数据、根内读流、路径与 IPC 边界；真实目录只读验证 | done | 目录/IPC 回归、preload 隔离加载和真实目录只读检查通过；系统选择器/最终界面人工验收留 WP-007，发布留 WP-009 |
| WP-003 | Android SAF 读取适配 | 共享本地模型 | apps/mobile Java 原生插件、TS 桥与测试 | 只读选择、持久授权/恢复、当前层元数据和原生读流；桥/单元/构建与设备验证，平台缺口单列 | done | 桥、Java 单元、lint/双 APK 和 API 33/35 独立读取证据通过；API 29/其它提供者、实际撤权/目录移除还要验证；写入留 WP-010 |
| WP-004 | Windows HTTP 读取与任务注册 | WP-002、共享批量模型、WP-012 | apps/desktop 主进程及 HTTP 回归 | /v1 设备/当前层接口、异步下载准备/清单/content、通用查询/取消、会话及单次 ID、端口冲突与退出清理通过；手机发布结果以 receiver succeeded 为准 | done | 严格 JSON/头/路由/会话、异步下载与单次领取、查询/取消/期限、进程名额及退出/失败清理已实现；最小 HTTP 回归和工程检查通过；已提交 096dfec；LAN/Android/最终界面验证由后续包覆盖 |
| WP-005 | Windows HTTP 接收 | WP-004、WP-009、WP-012 | apps/desktop 主进程及 HTTP 回归 | uploads 登记、单次 PUT、压缩体/原文全校验后逐项发布、超限/断流/取消/部分结果/响应丢失通过 | done | 上传异步预检、单次 PUT、完整原文校验后逐项发布、取消/期限/响应丢失/清理重试已实现；最小接收回归和双端构建通过；已提交 9c4614c；实际 LAN、恢复、文件系统与规模资源缺口保留 |
| WP-006 | Android 原生 HTTP 与持续通知 | WP-003、WP-005、WP-010、共享批量模型、WP-013 | apps/mobile Java 原生编排/通知服务、TS 桥及最小回归 | 双向 HTTP/会话/有限流、sender/receiver 区分、完整验证后发布、真实进度、通知保持及显式取消 | done | 严格 JSON/HTTP/上下文、防重/回执只查询、原生归档与逐项发布、应用级任务/持续通知及 Activity 重连已实现；Java/TS 桥、lint、双 APK、互通及 TC-011 的实际 LAN、后台、重连、取消和原文属性核对通过；下一 WP-007 |
| WP-007 | 最小验证界面 | WP-004、WP-005、WP-006 | apps/desktop renderer、apps/mobile/src | 目录选择/元数据、服务状态、手动 IP、双向传输及结果可操作；双端构建通过 | planned | 无实现；桌面 antd 与移动 antd-mobile 分别适配 |
| WP-008 | 真机验收与 M-001 结论 | 共享模型、目录、归档、发布和 HTTP 模块；对应设备验证授权 | 测试设备与 testing/ 文档 | Android 10 及较新真机组合、实际 LAN HTTP、授权恢复、内容校验和故障用例通过 | planned | 需要设备；缺少平台时保留缺口，M-001 暂不关闭 |
| WP-009 | Windows 新文件暂存与发布 | WP-002 | apps/desktop 主进程与回归 | 独立测试目录内验证写流、同名拒绝、发布竞争、失败/取消清理；不触碰真实存档 | done | 原生显式写授权/只读预检、同父目录 wx 候选、sync/link/最终回读已实现；最小发布回归通过；已提交 63ddb34；其他卷、命名等价、强杀孤儿候选与规模实测保留缺口 |
| WP-010 | Android SAF 新文件写入 | WP-003 | apps/mobile Java 发布器/SAF 后端及单元测试 | 独立测试目录内验证写授权、新建、校验、名称冲突及失败残留；原生流不跨 JS，实际 SAF 验证一起完成 | done | 显式进程/系统授权分离、只读预检、新 ID/父/名核实、常规 FD 身份/非截断 rw、写后回读/元数据及独立清理重试已实现；单元、lint/双 APK、原生互通及 API 33 实际 SAF 发布和外部原文核对通过；仅新建，真实存档只读 |
| WP-012 | Windows 原生归档与私有暂存 | WP-002、共享批量模型 | apps/desktop/src/main/archive-*.ts、目录读流检查点、独立格式夹具与回归、README.md | 按流源快照、受限 USTAR/gzip1 打包、完整解包校验、非法归档/计数/空间/取消/清理；固定跨端夹具与独立内容期望通过 | done | 归档回归、独立格式夹具、源变化、实际流硬限、取消/清理失败/所有权和并发释放通过；已提交 b507547；供 WP-004 复用 |
| WP-013 | Android Java 原生归档与私有暂存 | WP-003、共享批量模型；复用 WP-012 固定夹具 | apps/mobile Java Archive*.java、SafArchiveSource、单元/设备测试及共用格式夹具、原生互通检查脚本 | 与 Windows 同一归档语义、未知源长度实测、有限缓冲及缓存清理；Java 单元/lint/双 APK 与实际 SAF 设备集成全部通过 | done | Java 归档单元、lint/双 APK、API 33 实际 SAF 与 Windows/JVM 双向互通通过；含大文件、实际 SAF 子目录、未知长度、取消/复用/进程恢复及缓存释放；源内容与属性经外部复核 |

## 3. 执行与拆分规则

- 后续推荐实现顺序为 WP-007、WP-008；共享模型和双端私有归档作为已完成的前置模块复用。具体依赖见上表，不授权并行 Agent。
- 一包承担一个主要能力边界。跨平台协议变更、提供者差异、无法独立验证或新增依赖/配置迁移使范围扩大时先拆包；保留原包交接，同一交付物只写在一个包。详细规则见 `docs/plans/m001-directory-http.md` 第 6 节；新 ID 从 WP-014 起分配，最大已用编号只增不减。
- 实现前发现并读取目标路径实际存在且适用的 AGENTS.md、项目及目标语言编码规范；桌面应用规则位于 apps/desktop/AGENTS.md，要求完整读取 antd skill。设计授权不包含实现或提交权限。
- 工作包完成以针对性检查、受影响工程检查及明确剩余缺口为证据；没有真机证据的项保持未完成。完成、阻塞和下一步同步 INDEX、模块状态、用例和回归状态。
- 后续 M-002 至 M-004 仅保留设计中的拆分方向；进入对应里程碑时重新读取记忆并细化，不提前将整个产品当作一个工作包。
