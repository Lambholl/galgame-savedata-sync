---
doc_type: regression-notes
status: active
updated: 2026-11-22
tags: [回归测试, 当前状态]
---

# 当前回归状态

只保留仍需关注的问题和复验入口。单次运行记录由命令输出与 Git 保存。已复现、待修的缺陷登记在[已知问题](../development/known-issues.md)，功能的验收结论见[验收标准](acceptance.md)。

| 范围 | 状态 | 当前问题 | 复验入口 |
| --- | --- | --- | --- |
| 依赖手动审计 | open | `pnpm security:node` 报 2 条中危公告，都未处理：glob GHSA-3g3m-2fjr-6pw4（@capacitor/cli → rimraf），minimatch GHSA-g3hv-75wg-m249（eslint；electron-builder → @electron/universal）。`@homebridge/ciao`、`bonjour-service` 及其依赖没有命中 | pnpm security:check；Android 依赖另用 pnpm security:android |

模板、主题、基准和重复失败场景不在回归范围。只为覆盖边缘场景的未测项（断网方式、熄屏和 Doze、折叠屏、旧版 WebView、协议版本不同的真实设备等）不登记。
