---
doc_type: work-packages
status: active
id_prefix: WP
id_high_water: 65
updated: 2026-11-23
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
| WP-064 | 备份归属调整：共享层与电脑端（CR-027） | **共享层**：`SyncBackupSettings` 只剩备份库的 `keepCount`，删除 `SyncBackupPolicy`、`SyncBackupPreference`、`resolveBackupPolicy` 和按游戏增删设置的函数，`backup-settings.json` 的格式版本加 1，旧格式按读不懂的数据文件处理（改名留档、提示一次、用默认 10 份），不迁移；`withSyncPlanChoices` 用原快照按 `shouldBackup` 和 `shouldDeleteExtras` 重新生成计划，备份字节、容量与预算问题随之重算；`SyncProjectDescriptor` 去掉 `shouldBackup`；`SYNC_CAPABILITIES_VERSION` 7 → 8。**后端**：`dialer-sync.ts` 准备计划时 `shouldBackup=false`，不读对端描述或本机设置；本机确认（`sync-ipc.ts`、`sync-bridge.ts`）和 `remote-sync-requests.ts` 发出的 `sync.confirm` 带 `shouldBackup`，执行方按两个开关重新生成计划；删除接收端拿本机设置核对 `plan.shouldBackup` 的检查（`sync-registry.ts` 的 `verify`，`dialer-sync.ts` 的登记前核对和接收端核对）；`backup-store.ts` 轮换读备份库的统一份数，`setPreference`/`setDefaults` 合成一个设置份数的入口，`backup-ipc.ts`、`backup-bridge.ts` 同步。**界面**：传输页在计划有写入且目标有文件时显示备份开关，放在计划摘要里、和“保留目标多出的文件”并列，由共用的 `SyncPlanSummary` 渲染（`onBackupChange` 为 null 时只显示），供 WP-065 复用；设置页的备份库部分放保留份数，去掉全局备份开关；游戏的备份与恢复页去掉“跟随全局设置”和单独设置，只显示“已有份数 / 保留份数”和位置；四种语言文案同步。**完成标准**：共享层单元测试覆盖切换开关后的备份字节、预算问题和确认绑定；两个电脑端实例经回环地址，拨号方发起和监听方发起各传两个方向，开关开、关各一次：开时目标端多一份 `copy` 备份，关时不多，进入传输页、翻转方向和重新扫描后开关为关闭；目标端改小份数后，下一次传入按新份数轮换；旧格式 `backup-settings.json` 启动时改名并提示；共享层和电脑端的类型检查、ESLint、测试通过。移动端网页层仍引用删掉的共享导出，WP-065 完成前编译不过，`pnpm check` 归 WP-065 | 无 | implemented：代码完成，旧格式改名提示、设置页份数和备份页显示已在开发版上验证；计划页备份开关、两个电脑端实例的回环传输和改小份数后的轮换还没测 |
| WP-065 | 备份归属调整：Android 端（CR-027） | **原生层**：`SyncTransferEngine.java` 准备计划时 `shouldBackup=false`、确认时按开关重新生成计划，删除对 `SyncJobModel.backup` 读出的对端设置的依赖；`ListenerSyncRequests.java` 发出的 `sync.confirm` 带 `shouldBackup`，拨号方收到时按它生成计划；删除 `ListenerSyncJobs.java` 接收端拿本机设置核对 `plan.shouldBackup` 的检查和项目描述里的 `shouldBackup`；`BackupStore`、`BackupModel`、`SyncBackupsPlugin` 改为备份库的统一份数，旧格式 `backup-settings.json` 由 `AppDataRecovery` 按读不懂的值删除并提示；能力版本与 WP-064 一致。**界面**：`SyncCopyPage.tsx` 和 `use-remote-sync.ts` 接入 WP-064 的共用开关；设置页、`BackupPage.tsx`、`BackupPolicyFields.tsx`、`platform/backup-bridge.ts` 按 WP-064 的规则调整。**完成标准**：`pnpm test`、`pnpm check`、`pnpm android:unit` 通过；Android 与电脑真机，两种发起方式各传两个方向，开关开、关各一次，结果同 WP-064；Android 作为目标时按手机上的份数轮换；完成后同步 CR-027 影响一栏列出的架构文档和验收标准，删除 CR-027 | WP-064 | planned |

## 2. 执行与拆分规则

- 一包承担一个主要能力边界。跨平台协议变更、提供者差异、无法独立验证或新增依赖/配置迁移使范围扩大时先拆包；保留原包交接，同一交付物只写在一个包。
- 实现前读取目标路径实际存在且适用的 `AGENTS.md`、项目编码规范和目标语言规则。设计授权不包含实现或提交权限。
- 工作包完成以针对性检查、受影响工程检查和明确剩余缺口为证据；没有真机证据的项保持未完成。完成、阻塞和下一步同步 INDEX、模块状态、用例和回归状态。
- 每个工作包开始前重新读取记忆并细化。
- 不授权并行 Agent。
