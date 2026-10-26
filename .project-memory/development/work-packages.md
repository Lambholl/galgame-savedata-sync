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

设计文档已按用户授权提交 a8dcec3。用户要求继续下一工作包，当前允许 WP-011 共享批量契约的代码、测试、说明与记忆同步；无需 ADB。本包无提交/推送或设备操作授权。HTTP API 无业务消费者，允许原位修订 v1，不另建 v2；Java SAF 读取及既有设备验证边界继续有效。

详细范围与流程位于 `docs/plans/m001-directory-http.md`；[接口契约](../architecture/api-contracts.md)与[模块设计](../architecture/modules.md)维护当前边界。共享与平台说明见 `packages/shared/README.md`、`apps/desktop/README.md`、`apps/mobile/README.md`。基础设施、共享契约及双端目录读取已完成；Java SAF 通过 API 33 合成夹具复测与旧 API 35 读取/恢复验证；两机证据不混用。新文件发布、HTTP 与同步流程未实现，本次目录适配尚未远端验证。

双向唯一 tar.gz 方案见[Q-008](../requirements/open-questions.md)，详细设计位于仓库根目录的 `docs/plans/m001-tar-gzip-protocol.md`。WP-011 已原位修订 v1 批量数据声明、守卫、上下文匹配和常量，并通过共享/既有目录桥及双端构建；不包含编解码或真实 IO。WP-012/013 原生归档仍 planned，下一实现起点 WP-012 无需 ADB；planned 不表示已授权实现或检查通过。

## 2. M-001 工作包

| ID | 工作包 | 依赖 | 代码范围 | 退出条件与验证 | 状态 | 已完成 / 下一步 |
| --- | --- | --- | --- | --- | --- | --- |
| WP-001 | 共享模型与契约 | 用户已要求开始本包 | packages/shared、根检查入口与 tsconfig.base.json | 明确元数据空值、能力、错误、进度与终态；契约测试及严格类型检查通过 | done | 已实现版本 1 DTO、纯守卫、线格式常量/说明；15 项运行时测试、9 项类型反例及 pnpm check 通过；已提交 80a82e2 |
| WP-002 | Windows 目录读取适配 | WP-001 | apps/desktop 主进程、preload 与测试 | 目录引用独立持久化，当前层元数据、根内读流、路径边界与 IPC 检查通过；真实目录只读验证 | done | 已实现并通过 15 项桌面测试、pnpm check 和构建后 preload 隔离加载；真实 Windows 目录内容与修改时间前后一致。新文件发布留 WP-009，下一包为 WP-003 |
| WP-003 | Android SAF 读取适配 | WP-001 | apps/mobile Java 原生插件、TS 桥与测试 | 只读选择、持久授权/恢复、当前层元数据和原生读流；桥/单元/构建与设备验证，平台缺口单列 | done | 5 项桥、4 项新增 Java 单元、pnpm check、原生 lint/双 APK 通过；旧 API 35 真实目录及 API 33 独立夹具的选择/取消、进程重启恢复和原生流通过；换机复测完整回执已补齐，首次访问 ctime 边界见回归状态；平台与提供者缺口继续保留，写入留 WP-010；后续先完成 WP-011 批量契约 |
| WP-004 | Windows HTTP 读取与任务注册 | WP-002、WP-011、WP-012 | apps/desktop 主进程及 HTTP 集成测试 | /v1 设备/当前层接口、异步下载准备/清单/content、通用查询/取消、会话及单次 ID、端口冲突与退出清理通过；不误报手机发布成功 | planned | 复用 WP-012 归档；本包建立会话内任务注册表和 sender 状态，不接收上传、不实现文件发布；无需 ADB |
| WP-005 | Windows HTTP 接收 | WP-004、WP-009、WP-012 | apps/desktop 主进程及 HTTP 集成测试 | uploads 登记、单次 PUT、压缩体/原文全校验后逐项发布、超限/断流/取消/部分结果/响应丢失通过 | planned | 在 WP-004 注册表接入 receiver 状态，调用 WP-012 解包及 WP-009 非覆盖发布，不重复实现归档或发布原语；无需 ADB |
| WP-006 | Android 原生 HTTP 与前台编排 | WP-003、WP-005、WP-010、WP-011、WP-013 | apps/mobile Java 插件、TS 桥及测试 | 双向 HTTP/会话/有限流、sender 与 receiver 结果区分、完整校验后 SAF 发布、进度/取消与前台边界成立 | planned | 只编排 WP-013 归档和 WP-010 发布；构建及可注入网络测试无需 ADB，实际 SAF/前台和 LAN 往返验证需设备；不得用独立基准替代 |
| WP-007 | 最小验证界面 | WP-004、WP-005、WP-006 | apps/desktop renderer、apps/mobile/src | 目录选择/元数据、服务状态、手动 IP、双向传输及结果可操作；双端构建通过 | planned | 无实现；桌面 antd 与移动 antd-mobile 分别适配 |
| WP-008 | 真机验收与 M-001 结论 | WP-001 至 WP-007、WP-009 至 WP-013；对应设备验证授权 | 测试设备与 testing/ 文档 | Android 10 及较新真机矩阵、实际 LAN HTTP、授权恢复、内容校验和故障用例通过 | planned | 需要设备；缺少平台仍保留缺口，不关闭 M-001 |
| WP-009 | Windows 新文件暂存与发布 | WP-002 | apps/desktop 主进程与测试 | 独立测试目录内验证写流、同名拒绝、发布竞争、失败/取消清理；不触碰真实存档 | planned | 从 WP-002 拆出，尚未实现；须在 WP-005 前完成，不向 Renderer 暴露任意写入 |
| WP-010 | Android SAF 新文件写入 | WP-003 | apps/mobile 原生适配及测试 | 独立测试目录内验证写授权、新建、校验、名称冲突及失败残留；原生流不跨 JS | planned | 从 WP-003 拆出；独立调试基准未交付正式发布适配。保留平台内部单文件边界，由 WP-006 聚合批次；需设备验证提供者改名/歧义与不修改既有文件，不承诺 SAF 排他创建；真实存档保持只读 |
| WP-011 | 共享 tar.gz 批量契约 | WP-001；本次批量协议设计 | packages/shared/src、test、README.md；设计/记忆同步 | 原位修订 v1 的批量 DTO/守卫/路由/头/错误及上限常量；清单对应/求和、角色终态、未知结果、类型反例、旧目录桥回归与 pnpm check 通过 | done | 32 项运行时、16 项类型反例及 pnpm check（含 16 桌面/5 移动桥、双端构建）通过；保持目录 DTO，无新增依赖/IO；下一包 WP-012；本包未提交、未连接设备 |
| WP-012 | Windows 原生归档与私有暂存 | WP-002、WP-011 | apps/desktop 主进程归档模块、独立夹具及测试 | 按流源快照、受限 USTAR/gzip1 打包、完整解包校验、非法归档/计数/空间/取消/清理；固定跨端夹具与独立内容期望通过 | planned | 无需 ADB；只写自身私有临时目录，不发布目标文件、不提供 HTTP；包内明确流/缓存所有权与可观测源变化边界 |
| WP-013 | Android Java 原生归档与私有暂存 | WP-003、WP-011；复用 WP-012 固定夹具 | apps/mobile Java 归档模块、单元/仪器测试及共用格式夹具 | 与 Windows 同一归档语义/故障矩阵、未知源长度实测、有限缓冲及缓存清理；Java 单元/lint/双 APK 通过，SAF 实测缺口单列 | planned | JVM 纯 IO 及构建无需 ADB；调用实际 SAF 原生读流的集成验证需要设备；不申请目标写授权、不做 HTTP 或 SAF 最终发布 |

## 3. 执行与拆分规则

- 设计交付后的推荐实现顺序为 WP-011、WP-012、WP-004、WP-009、WP-005、WP-013、WP-010、WP-006、WP-007、WP-008；先稳定共享数据和私有归档，再接网络及目标发布。具体依赖见上表，不授权并行 Agent。
- 一包只承担一个主要能力边界。跨平台契约变更、提供者差异、无法独立验证或新增依赖/配置迁移使范围扩大时先拆包；保留原包交接，新包不重复承诺。详细规则见 `docs/plans/m001-directory-http.md` 第 6 节；新 ID 从 WP-014 起分配，不回退高水位。
- 实现前读取并满足根 AGENTS.md、antd skill、项目及目标语言编码规范；apps 修改另读取子目录规则。设计授权不能当作实现或提交授权。
- 工作包完成以针对性检查、受影响工程检查及明确剩余缺口为证据；真机未测不能写成产品通过。完成、阻塞和下一步同步 INDEX、模块状态、用例和回归状态。
- 后续 M-002 至 M-004 仅保留设计中的拆分方向；进入对应里程碑时重新读取记忆并细化，不提前将整个产品当作一个工作包。
