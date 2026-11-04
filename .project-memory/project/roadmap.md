---
doc_type: roadmap
status: active
priority: high
owner: project
id_prefix: M
id_high_water: 4
updated: 2026-11-04
tags: [路线图, 里程碑]
related_files: []
---

# 项目路线图

## 目录

- [1. 里程碑](#1-里程碑)
- [2. 当前计划](#2-当前计划)
- [3. 真实存档开放](#3-真实存档开放)

只保留当前和计划中的里程碑；已完成阶段的有效结果吸收到项目目标、架构或决策后删除历史行。

## 1. 里程碑

| 里程碑 | 目标 | 计划时间 | 状态 |
| --- | --- | --- | --- |
| M-003 | 地址变更与重连：mDNS/DNS-SD 自动发现列表、稳定设备关联、手动 IP 入口和改址保留配置 | 待安排 | planned |
| M-004 | 完整首版：补齐预览体验和完整回归 | 待安排 | planned |

## 2. 当前计划

| 优先级 | 事项 | 依赖 | 状态 |
| --- | --- | --- | --- |
| P0 | 传输页“保留减少的文件”开关（CR-015） | 补 Activity 重建后读回开关选择 | 已实现，Windows 和 Android 真机合成目录已验证 |
| P0 | 保持 Android 用户发起传输由持续通知保持、当前状态独立、目录不汇总大小的边界 | [项目约束](../requirements/constraints.md)、[验收标准](../testing/acceptance.md) | active |
| P2 | 任意两台设备传输（REQ-022） | 对称控制通道；Android 监听和电脑拨号 | planned，未排期 |

## 3. 真实存档开放

M-002 已收口，真实存档覆盖按 `docs/plans/m002-sync-copy.md` 第 6 节的范围开放。
