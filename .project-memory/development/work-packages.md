---
doc_type: work-packages
status: active
priority: high
owner: development
id_prefix: WP
id_high_water: 9
updated: 2026-10-26
tags: [工作包, M-001, 设计]
related_files:
  - docs/plans/m001-directory-http.md
---

# 工作包登记

## 目录

- [1. 状态与入口](#1-状态与入口)
- [2. M-001 工作包](#2-m-001-工作包)
- [3. 执行与拆分规则](#3-执行与拆分规则)

## 1. 状态与入口

用户已授权 WP-002 实现并要求提交本次变更；必要暂存和一次本地提交的范围及失效条件见[项目章程](../project/charter.md)，不包含推送。真实两端目录只允许读取，不能写入、修改或删除；配置与边界测试仅使用独立临时夹具，不将真实路径写入仓库或记忆。设备连接不代表安装/写入授权，目录名称不用于推断运行器。planned 表示未开始，后续包仍按范围授权。

详细范围与流程位于 `docs/plans/m001-directory-http.md`；[接口契约](../architecture/api-contracts.md)与[模块设计](../architecture/modules.md)维护当前边界。共享说明见 `packages/shared/README.md`，Windows 读取说明见 `apps/desktop/README.md`。基础设施、共享契约及 Windows 目录读取已完成；Android SAF、新文件发布、HTTP 与同步流程未实现，本次目录适配尚未远端验证。

## 2. M-001 工作包

| ID | 工作包 | 依赖 | 代码范围 | 退出条件与验证 | 状态 | 已完成 / 下一步 |
| --- | --- | --- | --- | --- | --- | --- |
| WP-001 | 共享模型与契约 | 用户已要求开始本包 | packages/shared、根检查入口与 tsconfig.base.json | 明确元数据空值、能力、错误、进度与终态；契约测试及严格类型检查通过 | done | 已实现版本 1 DTO、纯守卫、线格式常量/说明；15 项运行时测试、9 项类型反例及 pnpm check 通过；已提交 80a82e2 |
| WP-002 | Windows 目录读取适配 | WP-001 | apps/desktop 主进程、preload 与测试 | 目录引用独立持久化，当前层元数据、根内读流、路径边界与 IPC 检查通过；真实目录只读验证 | done | 已实现并通过 15 项桌面测试、pnpm check 和构建后 preload 隔离加载；真实 Windows 目录内容与修改时间前后一致。新文件发布留 WP-009，下一包为 WP-003 |
| WP-003 | Android SAF 适配 | WP-001 | apps/mobile 原生插件及桥接口 | 选择、持久授权、当前层元数据与原生流可用；编译通过，真机缺口单独记录 | planned | 无实现；原生接口确定后安排设备授权验证 |
| WP-004 | Windows HTTP 读取 | WP-002 | apps/desktop 主进程 | 服务生命周期、设备描述、目录及文件下载端点集成检查通过 | planned | 无实现；仅开放已选择根目录 |
| WP-005 | Windows HTTP 接收 | WP-004、WP-009 | apps/desktop 主进程 | 新文件流式接收、校验、取消与结果查询通过；失败不覆盖原文件 | planned | 无实现；明确发布及取消竞争的实际结果 |
| WP-006 | Android 原生 HTTP | WP-003、WP-005 | apps/mobile 原生插件及桥接口 | 双向原生流、进度、校验、取消与前台边界成立；原生构建及故障检查通过 | planned | 无实现；若往返与生命周期范围过大，先拆包再实施 |
| WP-007 | 最小验证界面 | WP-004、WP-005、WP-006 | apps/desktop renderer、apps/mobile/src | 目录选择/元数据、服务状态、手动 IP、双向传输及结果可操作；双端构建通过 | planned | 无实现；桌面 antd 与移动 antd-mobile 分别适配 |
| WP-008 | 真机验收与 M-001 结论 | WP-001 至 WP-007、WP-009；对应设备验证授权 | 测试设备与 testing/ 文档 | Android 10 及较新真机矩阵、实际 LAN HTTP、授权恢复、内容校验和故障用例通过 | planned | 设备未检查；缺少某平台时保留验收缺口，不关闭 M-001 |
| WP-009 | Windows 新文件暂存与发布 | WP-002 | apps/desktop 主进程与测试 | 独立测试目录内验证写流、同名拒绝、发布竞争、失败/取消清理；不触碰真实存档 | planned | 从 WP-002 拆出，尚未实现；须在 WP-005 前完成，不向 Renderer 暴露任意写入 |

## 3. 执行与拆分规则

- 推荐顺序为 WP-001、WP-002、WP-003、WP-004、WP-009、WP-005、WP-006、WP-007、WP-008；将新文件暂存发布独立验证后再接 HTTP 接收。设备可用时提前验证 WP-003 的目录能力，最后由 WP-008 汇总证据。该依赖设计不授权并行 Agent。
- 一包只承担一个主要能力边界。跨平台契约变更、提供者差异、无法独立验证或新增依赖/配置迁移使范围扩大时，先拆出新包；保留原包已完成与剩余范围，新包不重复承诺交付物。详细规则见 `docs/plans/m001-directory-http.md` 第 6 节；新 ID 从 WP-010 起分配，不回退高水位。
- 实现前读取并满足根 AGENTS.md、antd skill、项目及目标语言编码规范；apps 修改另读取子目录规则。设计授权不能当作实现或提交授权。
- 工作包完成以针对性检查、受影响工程检查及明确剩余缺口为证据；真机未测不能写成产品通过。完成、阻塞和下一步同步 INDEX、模块状态、用例和回归状态。
- 后续 M-002 至 M-004 仅保留设计中的拆分方向；进入对应里程碑时重新读取记忆并细化，不提前将整个产品当作一个工作包。
