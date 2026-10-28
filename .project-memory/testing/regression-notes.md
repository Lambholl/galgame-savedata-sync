---
doc_type: regression-notes
status: active
priority: medium
owner: testing
updated: 2026-10-28
tags: [回归测试, 当前状态]
related_files: []
---

# 当前回归状态

只保留仍需关注的问题和复验入口。单次运行记录由命令输出与 Git 保存。

| 范围 | 状态 | 当前问题 | 复验入口 |
| --- | --- | --- | --- |
| 工程检查与既有套件 | passed | 无当前失败 | `pnpm check`、`pnpm test:shared`、`pnpm test:desktop`、`pnpm test:mobile`、`pnpm android:test` |
| 当前比较共享规则 | passed | 当前内容、空目录、失败/未知、名称/类型冲突、预算、计划防伪、备份格式和逐项结果针对性运行通过；原生扫描与写入尚待平台包 | apps/shared/src/sync；共享既有套件；文本/格式/lint/全工作区类型及双端构建 |
| 项目映射与异步发起复核 | passed | 桌面真实配置文件重启/改名/坏目录拒绝、移动适配层注入原生桥的改址/重启/异设备拒绝/通知后目录变化场景通过；新增覆盖流程尚待后续平台包 | 双端 library store/adapter；既有共享/桌面/移动套件、工程检查、桌面资源和 APK 构建 |
| Windows 当前扫描生产端 | passed | 实际临时目录的哈希/空文件/空目录/中文/缓冲区外大文件、源属性、未知长度、源变化/junction、预算/超时/取消关流/到期及 HTTP/IPC 上下文核对通过；Android 扫描尚待实现 | sync-scanner、sync HTTP、service bridge/IPC；共享/桌面既有套件与工程检查 |
| 双端界面与真机验收 | passed | 目录重组、独立界面、返回键、SAF、跨端传输和后台返回已通过真机验收 | 新构建与双端真机；见 TC-004、TC-014、TC-015 |
| Android SAF 初次访问时间变化 | unresolved | API 33 合成夹具首次读取后观察到 ctime 变化，原文和 mtime 一致，原因未确认 | 只读目录复验内容、大小和 mtime；ctime 是否变化按提供者能力记录 |
| Windows 跨进程发布恢复 | open | 强杀可能留下候选；其他卷和特殊名称等价未验证 | 独立目标夹具；按前缀自动删除或恢复旧任务不在方案内 |
| 满额规模、内存和容量预检 | passed | 双向 1 GiB、SHA-256/源属性、任务缓存清理和进程采样通过；功耗由用户取消，磁盘耗尽注入移出本轮 | 仓库根目录 `docs/validation/m001-resources.md`；双端编译、相关既有测试及容量探针 |
| 依赖手动审计 | open | 用户提供的 CI 日志报告 antd-mobile 间接依赖 deepmerge 的低危公告 GHSA-gcqx-w48m-w2h4，尚未处理 | pnpm security:check；Android 依赖另用 pnpm security:android |
| 远端 CI | pending | 用户提供的运行在 security:check 失败；安全审计已从日常 CI 移除，新配置待远端复验 | 推送后查看下一次工作流结果 |

界面检查用截图记录当时结果，不转成 DOM、选择器或颜色断言。模板、主题、基准和重复失败场景不在回归范围。
