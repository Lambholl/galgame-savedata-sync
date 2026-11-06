---
doc_type: architecture-dependencies
status: draft
priority: medium
owner: architecture
updated: 2026-11-07
tags: [依赖]
related_files: []
---

# 架构依赖

| 依赖 | 用途 | 约束 | 风险 | 状态 |
| --- | --- | --- | --- | --- |
| `@homebridge/ciao` 1.3.12（MIT） | 电脑端 mDNS / DNS-SD 广播 | 固定版本，由 electron-vite 打进 `out/main`；间接依赖 debug、tslib、source-map-support、fast-deep-equal。导入时会执行 `source-map-support/register`，改写主进程的错误堆栈格式 | 网卡绑定失败时只打印日志，不报错，因此广播状态显示 `advertising` 也不保证每块网卡都在广播；升级后要重新运行 `pnpm security:npm` 并复测广播 | active |

当前模块依赖见[模块设计](modules.md)与[工作包](../development/work-packages.md)；本表只登记需要额外说明约束的外部库。
