---
doc_type: module-status
status: active
updated: 2026-11-11
tags: [模块状态, 开发进度]
related_files: []
---

# 模块状态

## 目录

- [1. 当前模块](#1-当前模块)
- [2. 状态说明](#2-状态说明)

只记录还没做完、或做完但还有遗留事项的模块。做完且没有遗留的模块删除对应行，模块在哪看[代码地图](code-map.md)，历史由 Git 保存。验收结论和支持范围见 `docs/plans/m002-sync-copy.md` 第 6 节，验证缺口见[测试覆盖缺口](../testing/coverage-gaps.md)，后续顺序见[路线图](../project/roadmap.md)。

## 1. 当前模块

| 模块 | 状态 | 负责人 | 相关文件 | 边界与风险 | 下一步 |
| --- | --- | --- | --- | --- | --- |
| 两端目录扫描 | not-started | 开发 | desktop sync-target-files/new-file-publisher 与扫描器、Android 扫描 | 电脑写入途中被结束会在存档目录留下临时文件，扫描不跳过（BUG-009） | WP-039 |
| 传输进度 | not-started | 开发 | shared `sync-job-contracts.ts`、`sync-job-observation.ts`；desktop backup-store/sync-writer；Android BackupStore/SyncWriter/TransferService | 五段里备份阶段没有百分比，Android 通知在备份阶段显示不确定进度 | WP-042 |

## 2. 状态说明

| 状态 | 含义 |
| --- | --- |
| not-started | 尚未开始 |
| active | 正在开发 |
| blocked | 被阻塞 |
| done | 已完成，仍有遗留事项 |
