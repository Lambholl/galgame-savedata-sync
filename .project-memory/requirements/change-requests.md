---
doc_type: change-requests
status: active
id_prefix: CR
id_high_water: 27
updated: 2026-11-23
tags: [变更请求]
---

# 变更请求

保留还没完整吸收到当前需求、范围或架构的变更，以及实现、验证、迁移或外部依赖仍有缺口的变更。结论完全吸收且没有缺口后删除对应行，由 Git 保存历史。

| ID | 变更 | 原因 | 影响 | 状态 |
| --- | --- | --- | --- | --- |
| CR-027 | 写入前备份改为传输计划页的本次选项，由发起端选择，每次默认关闭；去掉两端全局和按游戏的备份开关；保留份数改为备份库的统一设置，不再按游戏单独设置 | 现有实现中每台设备都有全局和按游戏的“自动备份开关 + 保留份数”，传输按目标端的设置执行：在一台设备上发起传输时，起作用的是对端的设置，发起端看不到也改不了，本机的设置只在别的设备写入本机时生效。是否备份属于本次操作，由正在操作的发起端决定；保留份数决定备份库占用的空间，归存放备份的设备 | 需求见 REQ-015、REQ-025、Q-021。实施拆为 WP-064（共享层与电脑端）和 WP-065（Android 端），两端都完成前跨端传输因能力版本不同而拒绝。完成后同步[复制、备份与恢复约定](../architecture/sync-copy.md)第 3–6 节、[接口约定](../architecture/api-contracts.md)、[共享包](../architecture/shared-package.md)、[Windows 平台层](../architecture/windows.md)、[Android 平台层](../architecture/android.md)和[验收标准](../testing/acceptance.md)的“备份”一行 | accepted |
