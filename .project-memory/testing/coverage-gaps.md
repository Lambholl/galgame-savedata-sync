---
doc_type: coverage-gaps
status: active
priority: medium
owner: testing
updated: 2026-10-26
tags: [测试缺口]
related_files: []
---

# 测试覆盖缺口

只保留当前缺口；覆盖补齐后删除对应行。

| 缺口 | 风险 | 建议补充 | 优先级 | 状态 |
| --- | --- | --- | --- | --- |
| M-001 目录与 HTTP 尚未实现或验收 | CI 通过不覆盖 SAF 授权、真实提供者、双向内容及前台中断 | 按[工作包](../development/work-packages.md)实现并执行 TC-002 至 TC-015；真机覆盖 Android 10 及较新版本，ADB 只辅助部署调试 | P0 | open |
| 完整同步产品验收未实现 | 单文件测试流程不覆盖目录差异、覆盖复制、镜像、备份、两端发起或改址重连 | M-002 至 M-004 进入前继续拆分工作并按[验收标准](acceptance.md)补齐；真实存档覆盖开放前落实默认备份保护 | P0 | open |
