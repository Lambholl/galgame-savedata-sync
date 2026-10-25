---
doc_type: coverage-gaps
status: active
priority: medium
owner: testing
updated: 2026-10-25
tags: [测试缺口]
related_files: []
---

# 测试覆盖缺口

只保留当前缺口；覆盖补齐后删除对应行。

| 缺口 | 风险 | 建议补充 | 优先级 | 状态 |
| --- | --- | --- | --- | --- |
| 同步业务与真机验收未实现 | 空壳检查不覆盖真实目录读写、断网恢复、备份或同步正确性 | 获业务实现授权后按[验收标准](acceptance.md)验证 SAF、HTTP、地址变化和当前状态独立行为 | P0 | open |
