---
doc_type: architecture-modules
status: draft
priority: high
owner: architecture
updated: 2026-10-26
tags: [模块]
related_files: []
---

# 模块设计

## 目录

- [1. 设计状态](#1-设计状态)
- [2. M-001 模块边界](#2-m-001-模块边界)

## 1. 设计状态

共用契约已按 WP-001 实现，其余模块仍为 M-001 候选设计，不表示平台功能已经存在。当前实现与验证状态见[模块状态](../development/module-status.md)，依赖、退出条件和详细设计入口见[工作包](../development/work-packages.md)。不改变现有架构、技术栈或首版需求。

## 2. M-001 模块边界

| 模块 | 职责 | 输入 | 输出 | 依赖 | 相关文件 |
| --- | --- | --- | --- | --- | --- |
| 共用契约 | 已实现版本 1 DTO、错误/路由/头名映射、纯数据守卫 | 已解析 JSON/plain data | 只读 DTO 或守卫布尔值 | WP-001；不导入平台 API | packages/shared/src；完整契约见 packages/shared/README.md |
| Windows 目录适配 | 选择与恢复目录、当前层查询、根内读流、新文件暂存与发布 | 本地已登记 rootId、entryId | 当前条目、原生流和实际结果 | WP-002；Node 文件 API；受限 preload | apps/desktop 主进程与 preload |
| Android SAF 适配 | 用户授权、权限恢复、提供者能力和元数据、原生读写流 | 系统选择结果、本地目录引用 | 当前条目、原生流和能力/错误 | WP-003；Kotlin、SAF、ContentResolver | apps/mobile 原生插件 |
| Windows HTTP 读取 | 服务生命周期、设备描述、目录/文件读取 | 经验证的目录/条目引用 | 设备描述、当前层条目、字节流 | WP-004；Windows 目录适配 | apps/desktop 主进程 |
| Windows HTTP 接收 | 流式接收、校验、同名拒绝、发布、取消及短期结果查询 | transferId、目标父引用和单文件名、字节流 | 回执、进度或明确失败 | WP-005；读取服务与本地新文件写入 | apps/desktop 主进程 |
| Android 原生传输 | HTTP 流、暂存/校验/写入、进度、取消和前台中断 | 本地引用、手动地址、显式方向 | 本次进度、实际结果和残留说明 | WP-006；SAF 适配与 Windows HTTP | apps/mobile 原生插件及桥接口 |
| 最小验证界面 | 目录与元数据、服务状态、手动连接和双向传输操作 | 当前状态与用户操作 | 受限本地桥调用；源目标及结果展示 | WP-007；桌面 antd、移动 antd-mobile | apps/desktop renderer、apps/mobile/src |

目录配置与地址分别保存；Windows 使用稳定设备 ID、本地根目录引用和受限路径解析，Android 保存 SAF 引用与实际持久权限。界面不接收完整文件内容，大小未知/读取失败/不存在分别展示，目录不做递归汇总。

M-001 不实现同步算法、项目管理、备份、镜像、自动发现或 Windows 发起控制通道。上述能力在后续里程碑设计时复用经过验证的适配器，不能把测试用单文件传输直接当成完整同步产品。
