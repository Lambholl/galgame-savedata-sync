---
doc_type: known-issues
status: active
priority: medium
owner: development
id_prefix: BUG
id_high_water: 2
updated: 2026-10-26
tags: [已知问题]
related_files: []
---

# 已知问题

只保留仍未解决且会影响后续工作的缺陷；解决后将长期结论吸收到当前文档并删除对应行。

| ID | 问题 | 影响 | 临时方案 | 状态 |
| --- | --- | --- | --- | --- |
| BUG-2 | Android 系统返回键在移动界面无响应 | 弹层、子页面和主页面都无法通过系统返回操作；Capacitor 返回回调没有监听器时会吞掉按键，单页界面也没有浏览器历史可回退 | 已接入系统返回处理；仍需真机复验弹层、子页面和退出行为 | verify |

验证缺口见[测试覆盖缺口](../testing/coverage-gaps.md)。
