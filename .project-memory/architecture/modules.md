---
doc_type: architecture-modules
status: draft
priority: high
owner: architecture
updated: 2026-11-02
tags: [模块]
related_files: []
---

# 模块设计

## 目录

- [1. 设计状态](#1-设计状态)
- [2. 当前模块边界](#2-当前模块边界)

## 1. 设计状态

M-001 已完成。M-002 的当前扫描、复制/本机恢复计划、写入前全量备份、双端受保护写入、双向复制编排和双端界面已实现，WP-029 总体验收等用户确认结论。电脑发起复用 WebSocket 控制通道，mDNS/DNS-SD 自动发现和镜像删除尚未实现。协议规则见 `docs/plans/m002-sync-copy.md`，当前模块状态见[模块状态](../development/module-status.md)。

## 2. 当前模块边界

| 模块 | 职责 | 输入 | 输出 | 依赖与边界 | 相关文件 |
| --- | --- | --- | --- | --- | --- |
| 共享协议与项目模型 | 设备、目录、批量传输、游戏关联、错误和封闭 DTO；纯守卫与上下文匹配 | 已解析 JSON/plain data、本次快照与项目引用 | 只读 DTO、计划、校验结果 | 不导入平台 API、React 或组件库；文件 IO 留给平台 | `apps/shared/src/protocol`、`library`、`result.ts` |
| 共享同步模型 | 当前扫描、复制/本机恢复计划、写入前全量备份集合、结果与预算 | 两端完整快照、方向、项目/根和备份设置 | 不可变计划、备份文件集合、结果守卫 | 不执行 IO、哈希、历史查询；备份包含目标目录全部文件 | `apps/shared/src/sync` |
| Windows 目录与归档 | 目录登记、当前层读取、原生读流、私有快照和受限 USTAR/gzip1 | 系统选择器路径、rootId/entryId、本次源集合 | 公开目录 DTO、私有只读流与清单 | 源目录只读；缓存与同步根隔离，取消/清理失败显式报告 | `apps/desktop/src/main/directory-*`、`archive-*` |
| Windows HTTP 与控制 | 严格 HTTP 会话、扫描、双向任务、单次清单/内容、查询/取消、WebSocket `/v1/control` | 已验证设备/项目引用、扫描与任务请求 | 任务状态、内容流、目录应答和控制事件 | 默认不监听；文件内容不走控制通道；旧 v1 批量接口保持仅新建 | `http-*`、`sync-*`、`control-hub.ts`、`remote-sync-requests.ts` |
| Windows 备份、写入与恢复 | 目标目录全量备份、最近 3 次轮换、受保护覆盖、目录创建、本机恢复 | 固定 `SyncPlan`、已验证输入和本机目录授权 | 备份清单、逐项 `SyncApplyResult`、恢复任务 | 先备份并复核目标和输入再写入；通过候选、身份检查、fsync 和回读确认；目标独有条目保留 | `backup-*`、`sync-writer.ts`、`sync-target-files.ts`、`restore-registry.ts` |
| Android SAF 与归档 | 持久目录授权、当前层读取、递归扫描、原生哈希和私有归档 | 系统选择器引用、本次 SAF 源集合 | 目录 DTO、扫描快照、私有归档句柄 | URI 和文件字节不跨 JS；普通读取/扫描不保活，实际传输才使用 dataSync 服务 | `SafDirectories*`、`SyncScanner*`、`Archive*` |
| Android 备份、写入与恢复 | 私有备份、最近 3 次轮换、受保护覆盖、目录创建和本机恢复 | 固定计划、已验证输入、已授权 SAF 目标 | 备份清单、逐项结果、恢复任务 | 使用常规 FD 身份检查与非预截断写入；先备份目标目录全部文件；失败/未知如实报告 | `Backup*`、`SyncPlanModel`、`SyncWriter`、`SafSyncBackend`、`SyncWriteRuntime` |
| Android 控制与复制编排 | HTTP/WebSocket 客户端、双向复制、后台通知、电脑发起请求和结果回报 | 项目、设备、扫描/计划、确认和取消请求 | 原生任务状态、逐项结果、控制事件 | 控制消息格式对称；文件内容仍走 HTTP；页面重建查询原任务，不重放 | `ControlClient`、`SyncTransferEngine`、`SyncJobModel`、`platform/control-channel.ts` |
| 双端界面与共用渲染 | 设备、游戏、设置、传输、计划、详情、备份与恢复页面 | 平台适配器提供的只读 DTO 与用户操作 | 受限桥调用、状态展示和交互 | 页面状态/Hook/平台弹层各端维护；与平台无关的展示和设计变量放 shared/ui；主题支持跟随系统、浅色、深色并持久化 | `apps/shared/src/ui`、`apps/desktop/src/renderer/src`、`apps/mobile/src` |

真实存档覆盖等用户确认 WP-029 结论后，按 `docs/plans/m002-sync-copy.md` 第 6 节的范围开放；关闭备份、备份失败、目标变化、取消、部分成功和结果未知都有独立状态。镜像删除、自动发现及任意两台设备互传仍是后续范围。
