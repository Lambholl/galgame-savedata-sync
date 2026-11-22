---
doc_type: work-packages
status: active
id_prefix: WP
id_high_water: 63
updated: 2026-11-22
tags: [工作包]
---

# 工作包登记

## 目录

- [1. 当前工作包](#1-当前工作包)
- [2. 执行与拆分规则](#2-执行与拆分规则)

## 1. 当前工作包

已完成的工作包结论吸收到架构、实现细节和测试文档后删除，历史由 Git 保存。

| ID | 工作包 | 内容与完成标准 | 依赖 | 状态 |
| --- | --- | --- | --- | --- |
| WP-61 | 共享备份模型、保留份数上限与共用界面 | `apps/shared` 的 `SyncBackupManifest.reason` 增加 `manual`（保持 `schemaVersion = 1` 兼容已有清单），定义本机手动备份异步状态 DTO 与守卫；`BACKUP_KEEP_COUNT_MAX` 改为 `4096`；删除网络接口与控制通道 DTO、守卫中的 `backupKeepCount` 字段（`SyncProjectDescriptor`、`SyncPreparationPreview`、`sync.report` 的 `ready`）及跨端校验，不升级 `SYNC_CAPABILITIES_VERSION`（保持为 7）；四语言文案补充手动备份、进度与空目录提示；`BackupTimeline` 支持显示 `manual` 原因；`BackupPolicyBlock` 在关闭自动备份时仍显示保留份数；`SyncPlanSummary` 移除 `backupKeepCount` 并统一使用 `plan.backupOnPlain`；一并更新共享单元测试。完成标准：`pnpm test`、`pnpm typecheck` 通过，旧清单（`copy`/`restore`）与新清单（`manual`）均通过守卫，跨端协议守卫不再包含 `backupKeepCount` | 无 | planned |
| WP-62 | 桌面端手动备份与接口清理 | `apps/desktop`：`backup-store.ts` 支持从本机扫描快照创建 `reason = 'manual'` 备份（空目录返回 `manifest: null` 不创建空轮次，自动与手动备份按 `1–4096` 平级轮换）；主进程新增异步手动备份管理器（复核本机游戏与目录 → 占用 `TargetOperation` 名额 → 调用 `WindowsSyncScanner` 扫描 → 调用 `WindowsBackupStore` 创建），纳入 `hasRunningWork` 与 `activity()`，退出时随 `stop()` 取消并释放；`backup-bridge`、`backup-ipc` 与 `preload` 暴露受限接口 `startManual`、`manualState` 和 `cancelManual`；移除主进程（`sync-registry.ts`、`dialer-sync.ts`、`remote-sync-requests.ts`、`sync-bridge.ts`）和界面（`TransferPage.tsx`、`RestoreDetails.tsx`）对网络字段 `backupKeepCount` 的传递与校验；桌面端 `BackupPage.tsx` 增加“立即备份”按钮（点击后直接开始，不弹确认也不填备注），支持进度展示、取消以及空目录、完成和错误提示，完成后刷新列表并选中新备份；`BackupPolicyFields.tsx` 始终显示保留份数并适配 `1–4096` 输入；一并更新桌面端备份与协议回归测试。完成标准：`pnpm check` 与桌面端回归测试通过；实测立即备份、取消、空目录提示、关闭自动备份仍可手动备份、自动与手动平级轮换、本机恢复及 `keepCount > 10` 设置正常 | WP-61 | planned |
| WP-63 | Android 端手动备份与接口清理 | `apps/mobile`：`BackupModel.java` 与 `BackupStore.java` 允许 `reason = "manual"`，`KEEP_MAX` 改为 `4096`；应用级运行时（`DirectoryRuntime` / `SyncWriteRuntime`）持有本机异步手动备份任务并与传输、恢复共用 `TargetOperation` 名额（复核目录授权 → `SyncScanner` 扫描 → `BackupStore.create`），Activity 销毁不中断；`SyncBackupsPlugin.java` 与 TS 桥暴露受限接口 `startManual`、`manualState` 和 `cancelManual`；移除原生层（`SyncJobModel`、`SyncTransferEngine`、`SyncTransferRuntime`、`ListenerSyncJobs`、`ListenerSyncRequests`）和移动端前端页面（`SyncCopyPage`、`PlanConfirm`、`use-remote-sync`、`sync-transfer-bridge`）对网络字段 `backupKeepCount` 的传递与校验；移动端 `BackupPage.tsx` 增加“立即备份”按钮（点击后直接开始，不弹确认也不填备注），支持进度展示、取消以及空目录、完成和错误提示；`BackupPolicyFields.tsx` 始终显示保留份数并适配 `Stepper` 多位数输入。完成标准：`pnpm check`、Android 单元测试和 APK 构建通过；真机实测立即备份（含大存档取消、空目录、关闭自动备份仍可手动备份、平级轮换、本机恢复）以及电脑端与移动端双向传输通过 | WP-61 | planned |

## 2. 执行与拆分规则

- 一包承担一个主要能力边界。跨平台协议变更、提供者差异、无法独立验证或新增依赖/配置迁移使范围扩大时先拆包；保留原包交接，同一交付物只写在一个包。
- 实现前读取目标路径实际存在且适用的 `AGENTS.md`、项目编码规范和目标语言规则。设计授权不包含实现或提交权限。
- 工作包完成以针对性检查、受影响工程检查和明确剩余缺口为证据；没有真机证据的项保持未完成。完成、阻塞和下一步同步 INDEX、模块状态、用例和回归状态。
- 每个工作包开始前重新读取记忆并细化。
- 不授权并行 Agent。
