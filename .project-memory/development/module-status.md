---
doc_type: module-status
status: active
priority: high
owner: development
updated: 2026-11-08
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
| 四语言界面、错误与原生通知 | done | 开发 | shared i18n/result/ui、双端 app/features/platform、desktop main、Android Java/res | Android 通知语言切换没有真机复核 | 真机复核通知语言 |
| Windows 分发包 | done | 开发 | apps/desktop/electron-builder.json、scripts/package-windows.mjs、双层 package.json、pnpm-lock.yaml | 没有配置代码签名；使用已编译资源与隔离的最小应用清单，不带 node_modules，主进程第三方依赖（ws、ciao）由 electron.vite.config.ts 打进 out/main；产物位于 apps/desktop/release | 下次发版前打一次桌面包，确认启动和连接 |
| Windows 设备页服务控制 | done | 开发 | apps/desktop/src/renderer/src/features/devices、src/bridge/service-bridge.ts、main/service-ipc.ts | 服务启停在设备页显式操作；原生层持有文件路径和内容，界面只读公开快照。设备页显示地址、运行时长、广播状态和连接二维码 | 两台手机先后连接时的排序未测，见 WP-034 |
| Android 独立备份与轮换 | active | 开发 | BackupStore/Model/Files、AndroidBackupIo、SyncBackupsPlugin、TS backup bridge | 备份移到 `Android/data` 后，备份和恢复已在真机合成目录验证 | 无 |
| Android 受保护写入与本机恢复 | active | 开发 | SyncPlanModel/Writer、SafSyncBackend、SyncWriteRuntime/Plugin、TargetOperation、TS sync-write bridge | Android 覆盖是原地写入，中断会留下新旧混合的文件，只能靠写入前备份恢复；删除目标多出的条目已在真机合成目录验证，Activity 重建后读回开关选择未跑 | 下次调整传输页时补 Activity 重建 |
| Windows 局域网广播 | active | 开发 | main/discovery-advertiser.ts、service-ipc.ts、index.ts、bridge/service-bridge.ts | 广播只在服务运行期间进行，失败不影响 HTTP 服务；防火墙拦截 UDP 5353 时本机无法察觉 | 开发版已被手机搜到；Portable 版防火墙未测，见 WP-032 |
| Android 局域网搜索 | active | 开发 | DeviceDiscoveryPlugin、DiscoveryBrowser、TS `platform/device-discovery.ts` | 只在有订阅时搜索，Activity 停止时暂停；只返回 IPv4；设备页“附近的设备”订阅它 | API 33、35 真机通过；网页重载未测 |

## 2. 状态说明

| 状态 | 含义 |
| --- | --- |
| not-started | 尚未开始 |
| active | 正在开发 |
| blocked | 被阻塞 |
| done | 已完成，仍有遗留事项 |
