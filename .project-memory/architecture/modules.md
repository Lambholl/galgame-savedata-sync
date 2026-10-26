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

v1 本地/批量共享契约、双端目录读取、Windows 私有归档及 HTTP sender 已实现，Java SAF 在 API 33/35 分别通过读取验证。Java 归档、HTTP receiver/Android 网络、目标发布及界面集成仍待实现。tar.gz 批量设计位于仓库根目录的 `docs/plans/m001-tar-gzip-protocol.md`；Windows/Java 归档与目标发布各自独立验证，网络包只负责集成编排。当前实现与验证状态见[模块状态](../development/module-status.md)，依赖与退出条件见[工作包](../development/work-packages.md)。

## 2. M-001 模块边界

| 模块 | 职责 | 输入 | 输出 | 依赖 | 相关文件 |
| --- | --- | --- | --- | --- | --- |
| 共用契约 | 已实现 v1 本地目录及批量清单、映射、状态/结果、会话/资源/错误常量；纯守卫与任务上下文匹配 | 已解析 JSON/plain data；本次清单/方向及 receiver 目标请求 | 只读 DTO 或校验布尔值，不证明真实 IO | 已实现共享模块；不导入平台 API | packages/shared/src；packages/shared/README.md |
| Windows 目录读取适配 | 已实现选择登记与恢复、当前层查询、根内原生只读流 | 主进程选择器路径或本地 rootId/entryId | 公开 DTO 或仅主进程持有的 Readable | WP-002；无源目录写入入口 | apps/desktop 主进程与 preload |
| Windows 新文件暂存发布 | 候选写流、同名拒绝、发布与失败/取消清理 | 独立测试目录与新文件请求 | 新文件结果或残留说明 | WP-009；依赖 WP-002，不向 Renderer 暴露任意写入 | apps/desktop 主进程与测试 |
| Android SAF 读取适配 | 已实现只读授权/恢复、当前层元数据、原生读流，API 33/35 读取验证通过 | 系统选择结果、本地目录引用 | 当前条目、原生 InputStream 和能力/错误 | WP-003；Java、SAF、ContentResolver | apps/mobile 原生插件；apps/mobile/README.md |
| Android SAF 新文件写入 | 候选写授权、新建、原生写流与残留处理 | 独立测试目录与新文件请求 | 校验后的实际结果/残留 | WP-010；依赖 WP-003，先于 WP-006 | apps/mobile 后续原生适配 |
| Windows 私有归档 | 已实现源快照/变化检查、受限 USTAR/gzip1 编解码、完整计数/哈希/结束校验和缓存所有权/取消清理 | 本次源引用或清单/归档流、可选 signal/进度回调 | 主进程私有只读流句柄、实测清单；完整验证后返回，不发布目标 | WP-012；Windows 读取/共享批量契约；固定夹具供 Java 复用 | apps/desktop/src/main/archive-*.ts、独立合成夹具 |
| Android Java 私有归档 | 原生源快照及同格式编解码、有限缓冲/上限/取消和缓存释放 | SAF 原生读流或清单/归档流 | 仅原生持有的私有缓存和校验结果 | WP-013；Android 读取/共享批量契约；复用 Windows 固定夹具；不写 SAF 目标 | apps/mobile Java 模块及测试 |
| Windows HTTP 读取与任务注册 | 已实现显式服务启停/会话、目录、异步下载/单次 content、状态/取消、期限与清理；默认不监听 | 经验证的引用、本次集合 | 设备/会话描述、当前层、tar.gz 流及 sender 实际状态 | WP-004；Windows 读取、共享批量契约与 WP-012 | apps/desktop/src/main/http-*.ts、transfer-registry.ts、index.ts、HTTP 集成测试 |
| Windows HTTP 接收 | 编排完整接收/归档校验及非覆盖发布，接入 receiver 状态 | 清单、逐项目标引用、tar.gz 原生流 | 逐文件实际结果、进度及残留 | WP-005；WP-004/WP-009/WP-012 | apps/desktop 主进程 |
| Android 原生传输 | HTTP/会话编排、归档/校验后发布、进度/取消/前台边界 | 本地引用、本次集合、手动地址和方向 | sender/receiver 分开的状态、逐文件实际结果和残留 | WP-006；Android 读取、共享批量契约与 WP-005/WP-010/WP-013 | apps/mobile 原生插件及桥接口 |
| 最小验证界面 | 目录与元数据、服务状态、手动连接和双向传输操作 | 当前状态与用户操作 | 受限本地桥调用；源目标及结果展示 | WP-007；桌面 antd、移动 antd-mobile | apps/desktop renderer、apps/mobile/src |

目录配置与地址分别保存；Windows 使用稳定设备 ID、本地根目录引用和受限路径解析，Android 保存 SAF 引用与实际持久权限。界面不接收完整文件内容，大小未知/读取失败/不存在分别展示，目录不做递归汇总。

M-001 不实现同步算法、项目管理、备份、镜像、自动发现或 Windows 发起控制通道。上述能力在后续里程碑设计时复用经过验证的适配器，不能把测试目录内的归档往返直接当成完整同步产品。
