---
doc_type: work-packages
status: active
priority: high
owner: development
id_prefix: WP
id_high_water: 29
updated: 2026-11-04
tags: [工作包, M-002, 验收]
related_files:
  - docs/plans/m002-sync-copy.md
---

# 工作包登记

## 目录

- [1. 当前工作包](#1-当前工作包)
- [2. 执行与拆分规则](#2-执行与拆分规则)

## 1. 当前工作包

当前没有进行中的工作包。M-002 的规则、验收场景和结论见 `docs/plans/m002-sync-copy.md` 第 6 节。

## 2. 执行与拆分规则

- 一包承担一个主要能力边界。跨平台协议变更、提供者差异、无法独立验证或新增依赖/配置迁移使范围扩大时先拆包；保留原包交接，同一交付物只写在一个包。
- 最大已用编号为 29，新编号从 WP-030 起分配，高水位只增不减。
- 实现前读取目标路径实际存在且适用的 `AGENTS.md`、项目编码规范和目标语言规则；桌面应用规则位于 `apps/desktop/AGENTS.md`，要求完整读取 `antd` skill。设计授权不包含实现或提交权限。
- 工作包完成以针对性检查、受影响工程检查和明确剩余缺口为证据；没有真机证据的项保持未完成。完成、阻塞和下一步同步 INDEX、模块状态、用例和回归状态。
- M-002 不做 Android 10 实测；M-003/M-004 进入时重新读取记忆并细化。
- 不授权并行 Agent。
