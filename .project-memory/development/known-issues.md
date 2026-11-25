---
doc_type: known-issues
status: active
id_prefix: BUG
id_high_water: 33
updated: 2026-11-26
tags: [已知问题]
---

# 已知问题

记录已经发生、仍未解决且会影响后续工作的缺陷和阻碍；还没发生的写在[风险登记表](risks.md)。解决后将长期结论吸收到当前文档并删除对应行。

| ID | 问题 | 影响 | 临时方案 | 状态 |
| --- | --- | --- | --- | --- |
| BUG-033 | Tauri 宿主在 Linux 上编译失败：`generate_context!` 要求 PNG 窗口图标，`tauri.conf.json` 的 `bundle.icon` 只列了 `app-icon.ico`，于是去找不存在的 `src-tauri/icons/icon.png` | Linux 上 `pnpm lint` 的 Clippy 一步和 `pnpm dev:desktop` 都无法完成 | `app-icon.ico` 内含 256×256 的 PNG 帧，可以从中取出 PNG 加进 `bundle.icon`，由 WP-081 处理 | open |

验证缺口见[测试覆盖缺口](../testing/coverage-gaps.md)。
