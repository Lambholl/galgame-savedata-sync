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

当前授权为文档与项目记忆维护，见[章程](../project/charter.md)。WP-012 Windows 私有归档已完成且未提交；下一实现包为 WP-004，无需 ADB，待对应实现授权。真实存档保持只读，缓存不得位于所选源目录内。

详细范围与流程位于 `docs/plans/m001-directory-http.md`；[接口契约](../architecture/api-contracts.md)与[模块设计](../architecture/modules.md)维护当前边界。共享与平台说明见 `packages/shared/README.md`、`apps/desktop/README.md`、`apps/mobile/README.md`。基础设施、本地/批量共享契约、双端目录读取及 Windows 私有归档已实现；Java SAF 的 API 33 合成夹具与 API 35 真实目录证据分别适用。目标发布、HTTP 与同步流程未实现；桌面测试路径修复仍待远端 CI 复验。

双向唯一 tar.gz 方案见[Q-008](../requirements/open-questions.md)，详细设计位于仓库根目录的 `docs/plans/m001-tar-gzip-protocol.md`。共享批量契约及 WP-012 Windows 私有归档已实现并通过检查；Java 归档、HTTP、目标发布仍待后续包。下一实现起点 WP-004 无需 ADB；planned 不表示已授权实现或检查通过。表中只保留仍有实现或验证交接的工作包；已闭环共享契约的当前事实见[模块状态](module-status.md)和[接口契约](../architecture/api-contracts.md)，编号高水位保持 13。

## 2. M-001 工作包

| ID | 工作包 | 依赖 | 代码范围 | 退出条件与验证 | 状态 | 已完成 / 下一步 |
| --- | --- | --- | --- | --- | --- | --- |
| WP-002 | Windows 目录读取适配 | 已实现共享本地契约 | apps/desktop 主进程、preload 与测试 | 目录引用持久化、当前层元数据、根内读流、路径与 IPC 边界；真实目录只读验证 | done | 16 项目录/IPC 测试、preload 隔离加载和真实目录只读检查通过；系统选择器/最终界面人工验收留 WP-007，发布留 WP-009 |
| WP-003 | Android SAF 读取适配 | 已实现共享本地契约 | apps/mobile Java 原生插件、TS 桥与测试 | 只读选择、持久授权/恢复、当前层元数据和原生读流；桥/单元/构建与设备验证，平台缺口单列 | done | 桥、Java 单元、lint/双 APK 和 API 33/35 独立读取证据通过；API 29/其它提供者、实际撤权/目录移除仍待矩阵；写入留 WP-010 |
| WP-004 | Windows HTTP 读取与任务注册 | WP-002、已实现共享批量契约、WP-012 | apps/desktop 主进程及 HTTP 集成测试 | /v1 设备/当前层接口、异步下载准备/清单/content、通用查询/取消、会话及单次 ID、端口冲突与退出清理通过；不误报手机发布成功 | planned | 复用 WP-012 归档；本包建立会话内任务注册表和 sender 状态，不接收上传、不实现文件发布；无需 ADB |
| WP-005 | Windows HTTP 接收 | WP-004、WP-009、WP-012 | apps/desktop 主进程及 HTTP 集成测试 | uploads 登记、单次 PUT、压缩体/原文全校验后逐项发布、超限/断流/取消/部分结果/响应丢失通过 | planned | 在 WP-004 注册表接入 receiver 状态，调用 WP-012 解包及 WP-009 非覆盖发布，不重复实现归档或发布原语；无需 ADB |
| WP-006 | Android 原生 HTTP 与前台编排 | WP-003、WP-005、WP-010、已实现共享批量契约、WP-013 | apps/mobile Java 插件、TS 桥及测试 | 双向 HTTP/会话/有限流、sender 与 receiver 结果区分、完整校验后 SAF 发布、进度/取消与前台边界成立 | planned | 只编排 WP-013 归档和 WP-010 发布；构建及可注入网络测试无需 ADB，实际 SAF/前台和 LAN 往返验证需设备；不得用独立基准替代 |
| WP-007 | 最小验证界面 | WP-004、WP-005、WP-006 | apps/desktop renderer、apps/mobile/src | 目录选择/元数据、服务状态、手动 IP、双向传输及结果可操作；双端构建通过 | planned | 无实现；桌面 antd 与移动 antd-mobile 分别适配 |
| WP-008 | 真机验收与 M-001 结论 | 已实现共享契约及目录/归档/发布/HTTP/界面模块；对应设备验证授权 | 测试设备与 testing/ 文档 | Android 10 及较新真机矩阵、实际 LAN HTTP、授权恢复、内容校验和故障用例通过 | planned | 需要设备；缺少平台仍保留缺口，不关闭 M-001 |
| WP-009 | Windows 新文件暂存与发布 | WP-002 | apps/desktop 主进程与测试 | 独立测试目录内验证写流、同名拒绝、发布竞争、失败/取消清理；不触碰真实存档 | planned | 从 WP-002 拆出，尚未实现；须在 WP-005 前完成，不向 Renderer 暴露任意写入 |
| WP-010 | Android SAF 新文件写入 | WP-003 | apps/mobile 原生适配及测试 | 独立测试目录内验证写授权、新建、校验、名称冲突及失败残留；原生流不跨 JS | planned | 从 WP-003 拆出；独立调试基准未交付正式发布适配。保留平台内部单文件边界，由 WP-006 聚合批次；需设备验证提供者改名/歧义与不修改既有文件，不承诺 SAF 排他创建；真实存档保持只读 |
| WP-012 | Windows 原生归档与私有暂存 | WP-002、已实现共享批量契约 | apps/desktop/src/main/archive-*.ts、目录读流检查点、独立格式夹具与测试、README.md | 按流源快照、受限 USTAR/gzip1 打包、完整解包校验、非法归档/计数/空间/取消/清理；固定跨端夹具与独立内容期望通过 | done | 20 项专项及完整 pnpm check 通过（36 桌面/32 共享/5 移动桥、双端构建）；独立 Python 夹具、源变化、实际流硬限、取消/清理失败/所有权和并发释放通过；无新增依赖，无 HTTP/目标发布/ADB；本包未提交，下一 WP-004 |
| WP-013 | Android Java 原生归档与私有暂存 | WP-003、已实现共享批量契约；复用 WP-012 固定夹具 | apps/mobile Java 归档模块、单元/仪器测试及共用格式夹具 | 与 Windows 同一归档语义/故障矩阵、未知源长度实测、有限缓冲及缓存清理；Java 单元/lint/双 APK 通过，SAF 实测缺口单列 | planned | JVM 纯 IO 及构建无需 ADB；调用实际 SAF 原生读流的集成验证需要设备；不申请目标写授权、不做 HTTP 或 SAF 最终发布 |

## 3. 执行与拆分规则

- 后续推荐实现顺序为 WP-004、WP-009、WP-005、WP-013、WP-010、WP-006、WP-007、WP-008；共享契约与 Windows 私有归档作为已实现前置模块复用。具体依赖见上表，不授权并行 Agent。
- 一包只承担一个主要能力边界。跨平台契约变更、提供者差异、无法独立验证或新增依赖/配置迁移使范围扩大时先拆包；保留原包交接，新包不重复承诺。详细规则见 `docs/plans/m001-directory-http.md` 第 6 节；新 ID 从 WP-014 起分配，不回退高水位。
- 实现前发现并读取目标路径实际存在且适用的 AGENTS.md、项目及目标语言编码规范；桌面应用规则位于 apps/desktop/AGENTS.md，要求完整读取 antd skill。设计授权不能当作实现或提交授权。
- 工作包完成以针对性检查、受影响工程检查及明确剩余缺口为证据；真机未测不能写成产品通过。完成、阻塞和下一步同步 INDEX、模块状态、用例和回归状态。
- 后续 M-002 至 M-004 仅保留设计中的拆分方向；进入对应里程碑时重新读取记忆并细化，不提前将整个产品当作一个工作包。
