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

只保留仍需关注的问题和复验入口。单次运行记录由命令输出与 Git 保存。

| 范围 | 状态 | 当前问题 | 复验入口 |
| --- | --- | --- | --- |
| 静态检查与双端构建 | passed | 无新增失败；测试清理后的三个最小 JS 套件也分别通过 | `pnpm check`；`pnpm test:shared`、`pnpm test:desktop`、`pnpm test:mobile` |
| 共享、桌面和移动桥最小套件 | passed | 无新增失败；仍只覆盖稳定数据与原生边界 | `pnpm test:shared`、`pnpm test:desktop`、`pnpm test:mobile` |
| Java 单元、Android lint、APK 与归档互通 | passed | 测试压缩后曾完整通过；后续文档改动不需要重复设备测试 | `pnpm android:test` |
| 实际 LAN、SAF 发布、后台通知与取消 | passed | Android 10 和其它提供者未覆盖 | 双端真机与合成目录；见 TC-007、TC-011、TC-014 |
| Android SAF 初次访问时间变化 | unresolved | API 33 合成夹具首次读取后观察到 ctime 变化，原文和 mtime 一致，原因未确认 | 只读目录复验内容、大小和 mtime；ctime 是否变化按提供者能力记录 |
| Windows 跨进程发布恢复 | open | 强杀可能留下候选；其他卷和特殊名称等价未验证 | 独立目标夹具；按前缀自动删除或恢复旧任务不在方案内 |
| 规模、内存和磁盘耗尽 | open | 尚无全量 GiB、进程峰值内存/功耗和真实磁盘耗尽证据 | WP-008 使用独立数据和外部资源监控 |
| 最终界面与平台组合 | pending | 界面还没完成目录和传输操作 | WP-007、WP-008 的实际操作与截图 |
| 远端 CI | pending | 当前测试与 CI 调整尚无远端结果 | 推送后查看下一次工作流结果 |

界面检查用截图记录当时结果，不转成 DOM、选择器或颜色断言。模板、主题、基准和重复失败场景不在回归范围。
