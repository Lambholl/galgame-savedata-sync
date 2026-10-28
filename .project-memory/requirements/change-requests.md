---
doc_type: change-requests
status: active
priority: medium
owner: project
id_prefix: CR
id_high_water: 6
updated: 2026-10-28
tags: [变更请求]
related_files: []
---

# 变更请求

保留还没完整吸收到当前需求、范围或架构的变更，以及实现、验证、迁移或外部依赖仍有缺口的变更。结论完全吸收且没有缺口后删除对应行，由 Git 保存历史。

每次传输容量预检已吸收至 REQ-020、双端原生实现及 TC-036；持续通知和仅传输保活的边界已吸收至 REQ-016、原生实现与验收。最大已用编号保持 6。

| ID | 变更 | 原因 | 影响 | 状态 |
| --- | --- | --- | --- | --- |
| CR-005 | 默认备份保护从 M-004 提前到 M-002，使 M-002 可覆盖真实存档 | 用户在 M-002 拆包时明确选择调整阶段安排 | REQ-015 保持；分包、备份位置/轮次/恢复与协议基线已统一至 docs/plans/m002-sync-copy.md；镜像删除仍留 M-004 | approved；设计完成，双端实现与验收待完成 |
