---
doc_type: roadmap
status: active
id_prefix: M
id_high_water: 5
updated: 2026-11-21
tags: [路线图, 里程碑]
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
| M-005 | 任意两台设备传输（REQ-022）：Android 监听、电脑拨号，Android/Android 与电脑/电脑互传。M-003 已按对称角色设计协议和设备页，本地原型 `docs/design/device-page-v3/`（不进 Git）画出了 M-005 的设备页，在仓库根目录用 `pnpm exec vite --config docs/design/device-page-v3/vite.config.ts` 打开。角色设计见 [ADR-0004](../decisions/ADR-0004-symmetric-listener-dialer-roles.md)，实现拆分为 WP-47 到 WP-52，见[工作包登记](../development/work-packages.md)。WP-47 到 WP-51 的实现已完成，剩 WP-52 的全组合真机回归 | 待安排 | active |

## 2. 当前计划

| 优先级 | 事项 | 依赖 | 状态 |
| --- | --- | --- | --- |
| P0 | 保持 Android 用户发起传输由持续通知保持、当前状态独立、目录不汇总大小的边界 | [项目约束](../requirements/constraints.md)、[验收标准](../testing/acceptance.md) | active |
| P1 | 传输开始时两端都打开传输详情（REQ-023），即 WP-54 | 无 | done，两端实际运行验证放在 WP-52 |
| P1 | SAF 写入修改日期提示（Q-017），即 WP-53 | 电脑发起的部分依赖 WP-54 | done |
| P1 | 删除针对早期设计的兼容代码，即 WP-55 | 无 | done，真机验证放在 WP-52 |
| P2 | 任意两台设备传输（REQ-022），即 M-005 | Q-018、Q-019；对称控制通道；Android 监听和电脑拨号；M-003 的对称协议与设备页 | 实现已完成，WP-52 真机回归未排期 |

## 3. 真实存档开放

M-002 已收口，真实存档覆盖按[验收标准](../testing/acceptance.md)第 1 节的范围开放。
