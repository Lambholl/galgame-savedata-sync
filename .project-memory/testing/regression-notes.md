---
doc_type: regression-notes
status: active
updated: 2026-11-11
tags: [回归测试, 当前状态]
related_files: []
---

# 当前回归状态

只保留仍需关注的问题和复验入口。单次运行记录由命令输出与 Git 保存。已复现、待修的缺陷登记在[已知问题](../development/known-issues.md)。

| 范围 | 状态 | 当前问题 | 复验入口 |
| --- | --- | --- | --- |
| 完整首版回归 | planned | 范围见工作包 WP-043：真实存档双向传输、删除目标多出的条目、备份和恢复、大目录预览、传输中断网、写入途中结束进程 | 真实存档，两端各发起一次 |
| 依赖手动审计 | open | `pnpm security:npm` 报 4 条公告，都未处理：deepmerge 低危 GHSA-gcqx-w48m-w2h4（antd-mobile），glob 中危 GHSA-3g3m-2fjr-6pw4（@capacitor/cli → rimraf），minimatch 中危 GHSA-g3hv-75wg-m249（eslint；electron-builder → @electron/universal）。`@homebridge/ciao` 及其依赖没有命中 | pnpm security:check；Android 依赖另用 pnpm security:android |
| 依赖版本统一 | 桌面包已复核，Android 仪器测试未在设备上运行 | APK 依赖强制升级：kotlin-stdlib 2.2.0、kotlinx-coroutines 1.9.0、concurrent-futures 1.2.0、jspecify 1.0.1；设备测试平台的 gRPC 升到 1.69.1。electron-builder 用到的 plist、semver、ci-info、sax 被 overrides 合并。已通过构建和单元测试，桌面包打包后能启动和连接；仪器测试只构建未在设备上运行 | 运行仪器测试 |

界面检查结果不转成 DOM、选择器或颜色断言。模板、主题、基准和重复失败场景不在回归范围。只为覆盖边缘场景的未测项（折叠屏、旧版 WebView、协议版本不同的真实设备等）不登记。
