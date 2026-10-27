---
doc_type: work-packages
status: active
priority: high
owner: development
id_prefix: WP
id_high_water: 15
updated: 2026-10-27
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

M-001 只验证专用测试目录中的新文件往返，写入使用独立目标夹具，真实存档保持只读。双端目录、归档、发布、HTTP、通知保持和独立界面均已实现，目标真机验收通过。后续功能默认不新增或扩写自动化测试，使用 lint、编译、ADB 实操和截图验证；覆盖、删除同步与推送留在后续范围。

详细范围与流程位于 `docs/plans/m001-directory-http.md`；[接口约定](../architecture/api-contracts.md)与[模块设计](../architecture/modules.md)维护当前边界。共享与平台说明见 `apps/shared/README.md`、`apps/desktop/README.md`、`apps/mobile/README.md`。完整同步流程还没实现；桌面测试路径修复仍待远端 CI 复验。

双向唯一 tar.gz 方案见[Q-008](../requirements/open-questions.md)，详细设计位于仓库根目录的 `docs/plans/m001-tar-gzip-protocol.md`。planned 项尚未开始，也未获实现授权。表中保留仍有实现或验证交接的工作包；共享模型的当前事实见[模块状态](module-status.md)和[接口约定](../architecture/api-contracts.md)，最大已用编号保持 15。

## 2. M-001 工作包

| ID | 工作包 | 依赖 | 代码范围 | 退出条件与验证 | 状态 | 已完成 / 下一步 |
| --- | --- | --- | --- | --- | --- | --- |
| WP-014 | 多设备与游戏目录元数据 | WP-007 的目录/服务/任务桥 | apps/shared、桌面 HTTP/IPC、Android 原生连接与桥 | 保存多台设备与游戏关联，首期仅一个连接；本机目录持久化、远端目录元数据交换；任务固定原设备 | done | 有限 IPC/catalog 交换、单连接限制和真机验收通过 |
| WP-015 | 设备/游戏/设置双端正式界面 | WP-014、WP-007 | apps/mobile/src、apps/desktop/src/renderer/src、apps/shared、两端适配器与样式 | 两端独立页面与状态、游戏面板、目录/地址及复制、并列文件、方向和真实任务可用；移动控件考虑触控 | done | 独立界面、共享业务拆分、触控布局和跨端真机验收通过；覆盖、镜像删除、备份恢复留后续业务 |
| WP-002 | Windows 目录读取适配 | 共享本地模型 | apps/desktop 主进程、preload 与最小回归 | 目录引用持久化、当前层元数据、根内读流、路径与 IPC 边界；真实目录只读验证 | done | 目录/IPC 回归、preload 隔离加载和真实目录只读检查通过；系统选择器与最小目录界面已由 WP-007 实操验证，发布留 WP-009 |
| WP-003 | Android SAF 读取适配 | 共享本地模型 | apps/mobile Java 原生插件、TS 桥与测试 | 只读选择、持久授权/恢复、当前层元数据和原生读流；桥/单元/构建与设备验证，平台缺口单列 | done | 桥、Java 单元、lint、双 APK 和目标真机读取验收通过；写入见 WP-010 |
| WP-004 | Windows HTTP 读取与任务注册 | WP-002、共享批量模型、WP-012 | apps/desktop 主进程及 HTTP 回归 | /v1 设备/当前层接口、异步下载准备/清单/content、通用查询/取消、会话及单次 ID、端口冲突与退出清理通过；手机发布结果以 receiver succeeded 为准 | done | 严格协议、单次领取、查询/取消、期限、进程名额及退出/失败清理通过 |
| WP-005 | Windows HTTP 接收 | WP-004、WP-009、WP-012 | apps/desktop 主进程及 HTTP 回归 | uploads 登记、单次 PUT、压缩体/原文全校验后逐项发布、超限/断流/取消/部分结果/响应丢失通过 | done | 上传预检、单次 PUT、完整校验后逐项发布和清理重试通过；文件系统恢复与规模资源缺口见测试覆盖缺口 |
| WP-006 | Android 原生 HTTP 与持续通知 | WP-003、WP-005、WP-010、共享批量模型、WP-013 | apps/mobile Java 原生编排/通知服务、TS 桥及最小回归 | 双向 HTTP/会话/有限流、sender/receiver 区分、完整验证后发布、真实进度、通知保持及显式取消 | done | 严格 JSON/HTTP/上下文、防重/回执只查询、原生归档与逐项发布、应用级任务/持续通知及 Activity 重连已实现；Java/TS 桥、lint、双 APK、互通及 TC-011 的实际 LAN、后台、重连、取消和原文属性核对通过；WP-007 已接入最小界面 |
| WP-007 | 最小验证界面 | WP-004、WP-005、WP-006 | apps/desktop renderer/有限服务桥、apps/mobile/src、TransferEngine.java | 目录选择/元数据、服务状态、手动 IP、双向传输及结果可操作；双端构建通过 | done | 双端最小界面、真实选择器、LAN 双向、冲突、取消/清理、页面重载和 64 MiB 后台上传通过 |
| WP-008 | 规模资源验证与 M-001 结论 | 共享模型、目录、归档、发布和 HTTP 模块；真实设备验收已完成 | 测试设备与 testing/ 文档 | 补齐全量 GiB、进程峰值内存/功耗和磁盘耗尽证据，形成 M-001 结论 | planned | 真机组合、实际 LAN、授权恢复、内容校验和故障用例已通过；规模资源证据和 M-001 结论待补 |
| WP-009 | Windows 新文件暂存与发布 | WP-002 | apps/desktop 主进程与回归 | 独立测试目录内验证写流、同名拒绝、发布竞争、失败/取消清理；不触碰真实存档 | done | 原生写授权、只读预检、候选、排他发布、最终回读和清理通过；其他卷、名称等价、强杀恢复与规模实测见测试覆盖缺口 |
| WP-010 | Android SAF 新文件写入 | WP-003 | apps/mobile Java 发布器/SAF 后端及单元测试 | 独立测试目录内验证写授权、新建、校验、名称冲突及失败残留；原生流不跨 JS，实际 SAF 验证一起完成 | done | 显式进程/系统授权分离、只读预检、新 ID/父/名核实、常规 FD 身份/非截断 rw、写后回读/元数据及独立清理重试已实现；单元、lint/双 APK、原生互通及 API 33 实际 SAF 发布和外部原文核对通过；仅新建，真实存档只读 |
| WP-012 | Windows 原生归档与私有暂存 | WP-002、共享批量模型 | apps/desktop/src/main/archive-*.ts、目录读流检查点、独立格式夹具与回归、README.md | 按流源快照、受限 USTAR/gzip1 打包、完整解包校验、非法归档/计数/空间/取消/清理；固定跨端夹具与独立内容期望通过 | done | 归档回归、固定跨端夹具、源变化、预算、取消/清理和并发释放通过 |
| WP-013 | Android Java 原生归档与私有暂存 | WP-003、共享批量模型；复用 WP-012 固定夹具 | apps/mobile Java Archive*.java、SafArchiveSource、单元/设备测试及共用格式夹具、原生互通检查脚本 | 与 Windows 同一归档语义、未知源长度实测、有限缓冲及缓存清理；Java 单元/lint/双 APK 与实际 SAF 设备集成全部通过 | done | Java 归档单元、lint/双 APK、API 33 实际 SAF 与 Windows/JVM 双向互通通过；含大文件、实际 SAF 子目录、未知长度、取消/复用/进程恢复及缓存释放；源内容与属性经外部复核 |

## 3. 执行与拆分规则

- 下一项为 WP-008 的规模资源验证与 M-001 结论；共享模型和双端私有归档作为已完成的前置模块复用。具体依赖见上表，不授权并行 Agent。
- 一包承担一个主要能力边界。跨平台协议变更、提供者差异、无法独立验证或新增依赖/配置迁移使范围扩大时先拆包；保留原包交接，同一交付物只写在一个包。详细规则见 `docs/plans/m001-directory-http.md` 第 6 节；新 ID 从 WP-016 起分配，最大已用编号只增不减。
- 实现前发现并读取目标路径实际存在且适用的 AGENTS.md、项目及目标语言编码规范；桌面应用规则位于 apps/desktop/AGENTS.md，要求完整读取 antd skill。设计授权不包含实现或提交权限。
- 工作包完成以针对性检查、受影响工程检查及明确剩余缺口为证据；没有真机证据的项保持未完成。完成、阻塞和下一步同步 INDEX、模块状态、用例和回归状态。
- 后续 M-002 至 M-004 仅保留设计中的拆分方向；进入对应里程碑时重新读取记忆并细化，不提前将整个产品当作一个工作包。
