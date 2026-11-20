---
doc_type: work-packages
status: active
id_prefix: WP
id_high_water: 55
updated: 2026-11-20
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
| WP-47 | 共享模型改按角色 | 按 [ADR-0004](../decisions/ADR-0004-symmetric-listener-dialer-roles.md) 把方向、任务观察两端、`ErrorDevice` 和对比两侧改为 `listener`、`dialer`，`PROTOCOL_VERSION` 升到 2、能力 `schemaVersion` 升到 7、`SyncJobState.schemaVersion` 升到 5；旧批量接口保留平台方向和 `BATCH_PROTOCOL_VERSION=1`。代码已改，`pnpm check`、`pnpm test`、`pnpm android:test` 通过。缺口：电脑监听、Android 拨号的双向复制、两端发起、取消和断网还没在真机上回归 | 无 | done |
| WP-48 | 电脑拨号：连接 | 电脑端 DNS-SD 搜索、手动 IP、保存的设备，连接时按设备 ID 查找 5 秒（同 Q-016），控制通道客户端、2 秒重连和 4001、4002 关闭码；设备页加“连接其他设备”部分，按原型 `docs/design/device-page-v3/`。电脑不提供扫码。完成标准：两台电脑互相发现、手动连接、交换目录表、浏览对方目录；对方停服、改址、断开时按现有连接规则表现。实现见 [Windows 平台层](../architecture/windows.md)；本机多端口模拟和两个应用实例的检查已通过，见[回归状态](../testing/regression-notes.md) | WP-47 | done |
| WP-49 | 电脑拨号：传输 | 电脑作为拨号方编排扫描、计划、任务登记、内容上传和下载、取消和结果读取，对应 Android `SyncTransferEngine` 的拨号方职责；处理监听方经控制通道发来的 `sync.prepare`、`sync.confirm`、`sync.cancel`、`sync.job.*`。完成标准：电脑与电脑之间两个方向、两端发起，删除多出条目、关闭备份、取消、断网的合成目录用例通过。实现见 [Windows 平台层](../architecture/windows.md)；两进程合成目录用例已通过 | WP-48 | done |
| WP-50 | Android 监听：服务与连接 | Android 内置 HTTP 服务（`/v1/device`、`/v1/catalog`、`/v1/roots`、目录列举）、控制通道监听端（15 秒 ping，只允许一台设备在线）、NsdManager 注册服务、连接二维码；移动端设备页加“本机服务”部分（Q-014），含开关、地址和二维码。生命周期按 Q-018。完成标准：另一台 Android 能发现、扫码、手动连接，交换目录表并浏览目录；WP-48 完成后电脑同样能连；停止服务时注销广播。实现见 [Android 平台层](../architecture/android.md#14-本机服务监听方)；`pnpm check`、`pnpm test`、`pnpm android:test` 通过，JVM 测试覆盖 Android 拨号方连接、交换、浏览和 4001 断开。缺口：完成标准里的真机项（发现、扫码、手动连接、电脑连接、停止服务注销广播）和 Doze 下的监听都还没在真机上验证，放在 WP-52 | WP-47 | done |
| WP-51 | Android 监听：传输 | Android 提供 `/v1/sync/*`：能力、扫描、项目描述、任务登记、内容 GET 和 PUT、查询和取消，对应电脑 `http-service.ts`、`sync-registry.ts`；本机发起时经控制通道请求拨号方，对应电脑 `remote-sync-requests.ts`。监听端任务同样由持续通知保持；对方发起的任务开始时按 REQ-023 自动打开详情。完成标准：Android 与 Android 之间两个方向、两端发起的合成目录用例通过，取消、断网和 Activity 销毁按现有传输约束表现 | WP-50 | planned |
| WP-52 | M-005 全组合回归 | 四种组合：电脑监听和 Android 拨号（现有）、Android 监听和电脑拨号、电脑与电脑、Android 与 Android；每种覆盖两个方向、两端发起，用真实存档按[验收标准](../testing/acceptance.md)第 1 节回归，新组合各测一次 1 GiB 基线。另补 WP-50 的真机项：另一台 Android 和电脑能发现、扫码、手动连接 Android 本机服务，交换目录表并浏览目录，停止服务后广播消失，熄屏和 Doze 下仍能连上。另补 WP-54 的实际运行项：每种组合两端各发起一次、两个方向，两端都停在同一任务的详情；另一端在别的页面、电脑窗口最小化、Android 在后台时各验证一次。完成标准：验收标准和[回归状态](../testing/regression-notes.md)按组合更新 | WP-49、WP-51 | planned |
| WP-53 | SAF 写入修改日期提示 | 不属于 M-005，可先做。Android 作为目标、没有所有文件访问权限、计划里有文件写入时，Android 用黄色警告框提示这些文件的修改日期设不了，下次比较仍显示“不同”，附开启权限的入口。Android 发起时显示在计划页；电脑发起时 Android 没有计划页，WP-54 完成后显示在 Android 自动打开的传输详情页（Q-020）。电脑端不提示，协议不变。完成标准：有权限、无权限、计划没有文件写入三种情况下提示出现与否正确。实现见[实现细节](implementation-notes.md)的“Android 复制与本机恢复界面”；`pnpm check`、`pnpm test` 通过，无权限时的提示样式在网页预览里按亮色和暗色看过。缺口：三种情况还没在 Android 真机上验证 | 电脑发起的部分依赖 WP-54 | done |
| WP-54 | 传输开始时两端都打开传输详情 | REQ-023。传输开始时，发起端照常进入传输详情，另一端也自动打开同一任务的详情，在别的页面时也直接切换；电脑只切换页面，不还原窗口、不抢焦点；Android 在后台时只切换页面（Q-020）。完成标准：两端各发起一次、两个方向，两端都停在同一任务的详情；另一端在别的页面、电脑窗口最小化、Android 在后台时各验证一次。实现见[实现细节](implementation-notes.md)的“页面导航与返回”；电脑复制摘要的 `isPeerInitiated` 标明任务是否由对方发起。`pnpm check`、`pnpm test` 通过。覆盖现有组合：电脑监听和 Android 拨号的两端发起、电脑与电脑；Android 作监听方时的自动打开随 WP-51 实现。缺口：完成标准里的两端实际运行验证都还没做，放在 WP-52 | 无 | done |
| WP-55 | 删除针对早期设计的兼容代码 | 按[项目约束](../requirements/constraints.md)的“兼容性”。已知两处：备份设置读到 v2 时转换为 v3（shared `backup-retention.ts`、电脑 `backup-store.ts`、Android `BackupModel.java`，改为只认当前版本，其他版本按格式错误处理）；旧 v1 批量接口 `/v1/transfers/*` 及其任务展示（`transfer-registry.ts`、`new-file-publisher.ts`、`TransferEngine.java` 的批量部分、`NewFilePublisher.java`、两端的 `legacyTaskPreview`），先确认应用内已没有入口再删。同步删掉记忆里对应的描述。完成标准：两端检查和测试通过，现有传输、备份和恢复回归不变 | 无 | planned |

## 2. 执行与拆分规则

- 一包承担一个主要能力边界。跨平台协议变更、提供者差异、无法独立验证或新增依赖/配置迁移使范围扩大时先拆包；保留原包交接，同一交付物只写在一个包。
- 实现前读取目标路径实际存在且适用的 `AGENTS.md`、项目编码规范和目标语言规则；桌面应用规则位于 `apps/desktop/AGENTS.md`，要求完整读取 `antd` skill。设计授权不包含实现或提交权限。
- 工作包完成以针对性检查、受影响工程检查和明确剩余缺口为证据；没有真机证据的项保持未完成。完成、阻塞和下一步同步 INDEX、模块状态、用例和回归状态。
- 每个工作包开始前重新读取记忆并细化。
- 不授权并行 Agent。
