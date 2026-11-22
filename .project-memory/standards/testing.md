---
doc_type: standards-testing
status: active
updated: 2026-11-21
tags: [测试规范]
---

# 测试约定

`coding-standards` 技能 `references/testing.md` 的项目取值和差异。通用规则见该技能，这里不重复。

## 目录

- [取值](#取值)
- [差异](#差异)

## 取值

| 项目 | 取值 |
| --- | --- |
| 验证要回答的问题 | 功能是否按当前需求工作；存档数据会不会丢失或写错 |
| 相关测试入口 | `pnpm test`：脚本、共享包、电脑端（含 Tauri 宿主的 `cargo test`）和移动端网页层，不需要 Android 工具。改了 Android 原生代码时另跑 `pnpm android:unit`：Java 单元测试和归档互通核对，复用 Gradle 后台进程 |
| 全量测试入口 | `pnpm test:all`（`pnpm test` 加 `pnpm android:test`，后者在 `android:unit` 之外另跑 Android lint 和两个调试 APK 的构建）；`pnpm check` 和普通 CI 不跑测试 |
| 测试运行器 | Node 内置测试器加类型擦除；Java 单元测试用 JUnit，仪器测试用 AndroidJUnitRunner |
| 测试文件命名 | Node 测试是各包 `test/` 下的 `*.test.mjs`；Java 测试是 `*Test.java` |

## 差异

| 规则 | 原因 | 适用范围 |
| --- | --- | --- |
| 界面按常规字号和常用移动设备尺寸实际运行、截图验收，不验证极端字体大小 | 界面不进长期测试，验收范围要有边界 | 两端界面 |
| `pnpm android:unit` 只在改了 Android 原生代码时跑；`pnpm android:test` 只在准备发布或维护者要求时跑 | 两者都需要 JDK 和 Android SDK。`android:unit` 在后台进程已启动、Java 有改动时约 20 秒；`android:test` 每次启动新的 Gradle 进程并附带 Android lint 和打包，约一分半 | Android 原生 |
| 测试只用合成数据和系统临时目录，不读写真实存档 | 测试失败不能损坏存档 | 全部自动化测试 |
| 归档格式的跨语言夹具 `apps/desktop/test/fixtures/archive-v1.json` 由 Python 标准库独立生成，Node 和 Java 测试共用；`scripts/verify-archive-interop.mjs` 在 `pnpm android:unit` 和 `pnpm android:test` 里核对两端互通 | 两端编解码器各自实现，要有和实现无关的预期 | 归档 |
| 需要真机的测试只有 3 项（SAF 选择与读取、归档夹具互通、实际 SAF 两轮快照），运行方法见 [Android 平台层](../architecture/android.md#15-测试范围) | 授权和提供者行为只能在设备上验证 | Android 设备 |
| 同步功能的真机验收按[验收标准](../testing/acceptance.md)在两台设备上做，换设备时重新选择目录，不沿用另一台设备的结论 | 提供者、系统版本和目录授权因设备而异 | 跨端验收 |
