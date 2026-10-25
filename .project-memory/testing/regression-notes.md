---
doc_type: regression-notes
status: active
priority: medium
owner: testing
updated: 2026-10-26
tags: [回归测试, 当前状态]
related_files: []
---

# 当前回归状态

只保留当前仍需执行或仍有未解决问题的回归范围。单次运行历史由测试系统和 Git 保存。

| 回归范围 | 当前结果 | 未解决问题 | 证据 |
| --- | --- | --- | --- |
| 编码、格式、lint、严格类型、基础设施/共享测试、双端构建 | passed | 后续代码变更需运行新检查；不覆盖原生目录/HTTP 业务 | WP-001 最后代码修改后的 pnpm check 通过；含 2 项基础设施、15 项共享运行时测试、9 项类型反例及 Web/Electron 构建 |
| WP-001 共享契约 | passed | 守卫只校验解析后数据，不确认真实权限、内容、发布或前台生命周期 | pnpm test:shared、共享 typecheck；空值/错误、当前层引用、协议/名称/ID/哈希、进度/回执/取消/未知结果及只读边界 |
| ESLint 通用规范与 Prettier 集成 | passed | 语义与人工评审边界见 standards/coding-style.md | 12 个规则反例、4 个框架默认导出例外、eslint --fix 共用格式配置、42 项 Markdown 排除检查通过；eslint-config-prettier 检查无冲突；19 个源码文件仅有格式变更 |
| 桌面空壳运行 | passed | 未验证任何同步业务 | Electron 45.0.0 启动、已构建 renderer 和隔离 preload 加载检查 |
| npm 与 pnpm 安全 | passed | 仅表示当前已知公告，不覆盖系统二进制 | 新增 Prettier lint 插件后 pnpm security:npm 全量审计零漏洞；pnpm 10.34.8 OSV 零公告 |
| Android 依赖 | passed | 不代表 SDK/JDK 系统二进制或真实业务已验证 | 干净源码副本执行 security:android，自动生成 Capacitor 工程并解析全部配置；Maven 与 Gradle Core 共 273 项零已知公告 |
| Android 原生构建 | passed | 无真机测试 | android:build 成功；APK Manifest 实测 minSdk 29、targetSdk 36、明文 HTTP=true |
| 远端 CI | passed | 本次共享契约变更尚未推送，未在远端验证；不代表真机业务通过 | 用户于 2026-10-26 确认既有远端 CI 已通过；本次新增检查入口已在本地 pnpm check 验证 |
| 同步产品验收 | pending | 同步业务、SAF 插件、局域网服务与真机流程尚未实现 | testing/acceptance.md |
