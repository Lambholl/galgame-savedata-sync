---
doc_type: risks
status: active
id_prefix: R
id_high_water: 3
updated: 2026-11-26
tags: [风险]
---

# 风险登记表

记录还没发生、但可能影响项目的问题；已经发生的缺陷和阻碍写在[已知问题](known-issues.md)。风险消失且长期结论已吸收后删除对应行。

| ID | 风险 | 概率 | 影响 | 等级 | 应对策略 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| R-003 | WebKitGTK 在部分显卡驱动上可能白屏或渲染异常 | 中 | 中 | 中 | X11 和 Wayland 会话上开发版渲染正常；出现时由宿主在启动 WebView 前设置 WebKitGTK 的渲染环境变量 | open |

其余实现边界与验证风险见[模块状态](module-status.md)及[测试覆盖缺口](../testing/coverage-gaps.md)。
