---
doc_type: module-status
status: active
updated: 2026-11-22
tags: [模块状态, 开发进度]
---

# 模块状态

## 目录

- [1. 当前模块](#1-当前模块)
- [2. 状态说明](#2-状态说明)

只记录还没做完、或做完但还有遗留事项的模块。做完且没有遗留的模块删除对应行，模块在哪看[代码地图](code-map.md)，历史由 Git 保存。验收结论和支持范围见[验收标准](../testing/acceptance.md)，验证缺口见[测试覆盖缺口](../testing/coverage-gaps.md)，后续顺序见[路线图](../project/roadmap.md)。

## 1. 当前模块

| 模块 | 状态 | 负责人 | 相关文件 | 边界与风险 | 下一步 |
| --- | --- | --- | --- | --- | --- |
| Android 本机服务（监听方） | done | 开发 | Android `Listener*.java`、`LocalServicePlugin.java`、`SyncTransferRuntime.java`；移动 `platform/local-service*.ts`、`library-adapter.ts`、`sync-transfer-bridge.ts`、`features/devices/DevicesPage.tsx`、`features/transfer/` | 连接、目录表交换、目录浏览、广播、设备页和复制任务（`/v1/sync/*`、本机发起经控制通道交给拨号方、对方发起时打开详情）已实现，自动检查通过；传输只有临时 JVM 测试，没有长期测试。发现、手动连接和传输已在真机上验证，扫码和熄屏、Doze 下的监听还没验证 | 补真机验证，见[回归状态](../testing/regression-notes.md) |

## 2. 状态说明

| 状态 | 含义 |
| --- | --- |
| not-started | 尚未开始 |
| active | 正在开发 |
| blocked | 被阻塞 |
| done | 已完成，仍有遗留事项 |
