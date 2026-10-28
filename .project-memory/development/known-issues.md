---
doc_type: known-issues
status: active
priority: medium
owner: development
id_prefix: BUG
id_high_water: 5
updated: 2026-10-29
tags: [已知问题]
related_files: []
---

# 已知问题

只保留仍未解决且会影响后续工作的缺陷；解决后将长期结论吸收到当前文档并删除对应行。

| ID | 问题 | 影响 | 临时方案 | 状态 |
| --- | --- | --- | --- | --- |
| BUG-003 | 移动端传输详情轮询会让同一个文件的结果重复出现，并注入其他页面 | 结果列表重复，传输详情会污染其他页面的状态 | 暂无 | open |
| BUG-004 | 移动端传输完成后没有成功创建备份 | 目标端缺少本次传输对应的备份，恢复路径受影响 | 暂无 | open |
| BUG-005 | 桌面端“传输存档”仍不支持覆盖传输 | 目标已有内容时无法按计划完成覆盖 | 暂无 | open |

验证缺口见[测试覆盖缺口](../testing/coverage-gaps.md)。
