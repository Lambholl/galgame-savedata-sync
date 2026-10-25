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

共享契约及双端目录读取适配已实现，Java SAF 在 API 33/35 分别通过读取验证，其余模块仍待实现。用户已确定双向 tar.gz 批量传输，正式共享契约及 HTTP 模块须先按此方案细化。双端新文件发布分别拆为 WP-009/WP-010，HTTP 接收/原生传输必须等待对应写入包。当前实现与验证状态见[模块状态](../development/module-status.md)，依赖与退出条件见[工作包](../development/work-packages.md)。不改变既定首版需求。

## 2. M-001 模块边界

| 模块 | 职责 | 输入 | 输出 | 依赖 | 相关文件 |
| --- | --- | --- | --- | --- | --- |
| 共用契约 | 已实现版本 1 DTO、错误/路由/头名映射、纯数据守卫 | 已解析 JSON/plain data | 只读 DTO 或守卫布尔值 | WP-001；不导入平台 API | packages/shared/src；完整契约见 packages/shared/README.md |
| Windows 目录读取适配 | 已实现选择登记与恢复、当前层查询、根内原生只读流 | 主进程选择器路径或本地 rootId/entryId | 公开 DTO 或仅主进程持有的 Readable | WP-002；无源目录写入入口 | apps/desktop 主进程与 preload |
| Windows 新文件暂存发布 | 候选写流、同名拒绝、发布与失败/取消清理 | 独立测试目录与新文件请求 | 新文件结果或残留说明 | WP-009；依赖 WP-002，不向 Renderer 暴露任意写入 | apps/desktop 主进程与测试 |
| Android SAF 读取适配 | 已实现只读授权/恢复、当前层元数据、原生读流，API 33/35 读取验证通过 | 系统选择结果、本地目录引用 | 当前条目、原生 InputStream 和能力/错误 | WP-003；Java、SAF、ContentResolver | apps/mobile 原生插件；apps/mobile/README.md |
| Android SAF 新文件写入 | 候选写授权、新建、原生写流与残留处理 | 独立测试目录与新文件请求 | 校验后的实际结果/残留 | WP-010；依赖 WP-003，先于 WP-006 | apps/mobile 后续原生适配 |
| Windows HTTP 读取 | 服务生命周期、设备描述、目录读取与 tar.gz 合批下载 | 经验证的目录/条目引用、本次待传集合 | 设备描述、当前层条目、tar.gz 原生流 | WP-004；先细化批量契约；Windows 目录适配 | apps/desktop 主进程 |
| Windows HTTP 接收 | tar.gz 暂存/解包、逐项校验、同名拒绝、发布、取消及短期结果查询 | 本次任务清单、目标目录引用、tar.gz 原生流 | 逐文件回执、批次进度、明确失败或残留 | WP-005；依赖 WP-004、WP-009 | apps/desktop 主进程 |
| Android 原生传输 | tar.gz 原生打包/解包、HTTP 流、暂存/逐项校验/写入、进度、取消和前台中断 | 本地引用、本次待传集合、手动地址、显式方向 | 本次进度、逐文件实际结果和残留说明 | WP-006；SAF 适配与 Windows HTTP | apps/mobile 原生插件及桥接口 |
| 最小验证界面 | 目录与元数据、服务状态、手动连接和双向传输操作 | 当前状态与用户操作 | 受限本地桥调用；源目标及结果展示 | WP-007；桌面 antd、移动 antd-mobile | apps/desktop renderer、apps/mobile/src |

目录配置与地址分别保存；Windows 使用稳定设备 ID、本地根目录引用和受限路径解析，Android 保存 SAF 引用与实际持久权限。界面不接收完整文件内容，大小未知/读取失败/不存在分别展示，目录不做递归汇总。

M-001 不实现同步算法、项目管理、备份、镜像、自动发现或 Windows 发起控制通道。上述能力在后续里程碑设计时复用经过验证的适配器，不能把测试目录内的归档往返直接当成完整同步产品。
