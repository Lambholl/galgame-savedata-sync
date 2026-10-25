---
doc_type: regression-notes
status: active
priority: medium
owner: testing
updated: 2026-10-25
tags: [回归测试, 当前状态]
related_files: []
---

# 当前回归状态

只保留当前仍需执行或仍有未解决问题的回归范围。单次运行历史由测试系统和 Git 保存。

| 回归范围 | 当前结果 | 未解决问题 | 证据 |
| --- | --- | --- | --- |
| 编码、格式、lint、严格类型、基础设施测试、双端构建 | passed | 后续代码变更需运行新检查 | pnpm check；含 Node 安全补丁边界的 2 项基础设施测试 |
| 桌面空壳运行 | passed | 未验证任何同步业务 | Electron 45.0.0 启动、已构建 renderer 和隔离 preload 加载检查 |
| npm 与 pnpm 安全 | passed | 仅表示当前已知公告，不覆盖系统二进制 | 官方 npm 对 397 项依赖复审零漏洞；pnpm 10.34.8 OSV 零公告 |
| Android 依赖 | passed | 不代表 SDK/JDK 系统二进制或真实业务已验证 | security:android 全部可解析配置与 Gradle Core 实际 273 项零已知公告，统一补丁策略生效 |
| Android 原生构建 | passed | 无真机测试 | android:build 成功；APK Manifest 实测 minSdk 29、targetSdk 36、明文 HTTP=true |
| 远端 CI | not-run | 本轮未提交或推送，远端工作流未执行 | 已配置 Windows CI、固定 Action SHA、Node/JDK 与 npm/Maven 安全检查 |
| 同步产品验收 | pending | 同步业务、SAF 插件、局域网服务与真机流程尚未实现 | testing/acceptance.md |
