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
| 编码、格式、lint、严格类型、基础设施/共享/桌面测试、双端构建 | passed | Android SAF、新文件写入与 HTTP 业务未实现 | WP-002 最后代码修改后的 pnpm check 通过；2 项基础设施、15 项共享、15 项桌面测试，9 项类型反例及 Web/Electron 构建 |
| WP-001 共享契约 | passed | 守卫只校验解析后数据，不确认真实权限、内容、发布或前台生命周期 | pnpm test:shared、共享 typecheck；空值/错误、当前层引用、协议/名称/ID/哈希、进度/回执/取消/未知结果及只读边界 |
| ESLint 通用规范与 Prettier 集成 | passed | 语义与人工评审边界见 standards/coding-style.md | 12 个规则反例、4 个框架默认导出例外、eslint --fix 共用格式配置、42 项 Markdown 排除检查通过；eslint-config-prettier 检查无冲突；19 个源码文件仅有格式变更 |
| Windows 目录读取与有限 IPC | passed | 不覆盖系统选择器人工点击、实际 Electron 窗口交互、新文件写入或 HTTP；Node 路径检查不是并发命名空间原子隔离 | pnpm test:desktop 的 15 项测试；构建 CJS preload 在隔离环境加载，只有 Electron require，三个有限方法可用 |
| Windows 真实存档目录只读 | passed | 只验证当前层读取，不代表 Android 或同步产品验收；真实目录禁止写入/修改/删除 | 用户授权目录的适配器只读流与原生读取一致，配置恢复成功；前后内容哈希、条目及修改时间相同，路径/哈希不保存 |
| 桌面运行与原生选择器人工验收 | pending | 本次主进程/桥已构建并验证逻辑，尚未通过实际窗口人工交互检查 | 最终目录操作界面由 WP-007 接入，不能沿用空壳启动证据当作新功能通过 |
| npm 与 pnpm 安全 | passed | 仅表示当前已知公告，不覆盖系统二进制 | 新增 Prettier lint 插件后 pnpm security:npm 全量审计零漏洞；pnpm 10.34.8 OSV 零公告 |
| Android 依赖 | passed | 不代表 SDK/JDK 系统二进制或真实业务已验证 | 干净源码副本执行 security:android，自动生成 Capacitor 工程并解析全部配置；Maven 与 Gradle Core 共 273 项零已知公告 |
| Android 原生构建 | passed | 无真机测试 | android:build 成功；APK Manifest 实测 minSdk 29、targetSdk 36、明文 HTTP=true |
| 远端 CI | passed | 本次目录适配变更未推送，尚未远端验证；不代表真机业务通过 | 用户确认既有远端 CI 通过；本次含桌面测试的新 pnpm check 已在本地通过 |
| 同步产品验收 | pending | 同步业务、SAF 插件、局域网服务与真机流程尚未实现 | testing/acceptance.md |
