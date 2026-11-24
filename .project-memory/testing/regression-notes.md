---
doc_type: regression-notes
status: active
updated: 2026-11-25
tags: [回归测试, 当前状态]
---

# 当前回归状态

只保留仍需关注的问题和复验入口。单次运行记录由命令输出与 Git 保存。已复现、待修的缺陷登记在[已知问题](../development/known-issues.md)，功能的验收结论见[验收标准](acceptance.md)。

| 范围 | 状态 | 当前问题 | 复验入口 |
| --- | --- | --- | --- |
| 依赖手动审计 | open | npm 依赖没有命中公告。Android 依赖命中 1 条中危公告，未处理：org.json:json 20250517 的 GHSA-ghc9-756g-vrcv（超长数字字面量让解析耗时过长），只出现在 Capacitor 自带库 `capacitor-android` 的单元测试类路径（`debugUnitTest*`），不进 APK，项目构建不运行这些测试；应用代码里的 `org.json` 在设备上用的是 Android 系统自带的实现。随 Capacitor 升级消除，Capacitor 三个包要同版本整组升级并按[依赖表](../architecture/dependencies.md)复测，升级时机待维护者决定。`pnpm security:node` 在打包进 sidecar 的 Node 低于所在主版本最新的安全发布时报失败，本机 Node 只提示 | `pnpm security:node`；`pnpm security:android` |

模板、主题、基准和重复失败场景不在回归范围。只为覆盖边缘场景的未测项（断网方式、熄屏和 Doze、折叠屏、旧版 WebView、协议版本不同的真实设备等）不登记。
