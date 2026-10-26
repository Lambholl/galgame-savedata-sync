---
doc_type: architecture-modules
status: draft
priority: high
owner: architecture
updated: 2026-10-27
tags: [模块]
related_files: []
---

# 模块设计

## 目录

- [1. 设计状态](#1-设计状态)
- [2. M-001 模块边界](#2-m-001-模块边界)

## 1. 设计状态

v1 本地/批量共享模型、双端目录读取、双端私有归档、Windows HTTP sender/receiver 和新文件发布已经可用。WP-013 完成了实际 API 33 SAF 原生读流集成；Android SAF 单文件发布和 HTTP/通知保持传输已经可用；WP-007 最小目录、连接与传输界面已集成。tar.gz 批量设计位于仓库根目录的 `docs/plans/m001-tar-gzip-protocol.md`；Windows/Java 归档与目标发布分别验证，网络包负责集成编排。当前实现与验证状态见[模块状态](../development/module-status.md)，依赖与退出条件见[工作包](../development/work-packages.md)。

## 2. M-001 模块边界

| 模块 | 职责 | 输入 | 输出 | 依赖 | 相关文件 |
| --- | --- | --- | --- | --- | --- |
| 共享模型 | 提供 v1 本地目录及批量清单、映射、状态/结果、会话/资源/错误常量，以及纯守卫与任务上下文匹配 | 已解析 JSON/plain data；本次清单/方向及 receiver 目标请求 | 只读 DTO 或校验布尔值；真实 IO 由平台层检查 | 共享模块；不导入平台 API | packages/shared/src；packages/shared/README.md |
| Windows 目录读取适配 | 负责选择登记与恢复、当前层查询、根内原生只读流 | 主进程选择器路径或本地 rootId/entryId | 公开 DTO 或仅主进程持有的 Readable | WP-002；无源目录写入入口 | apps/desktop 主进程与 preload |
| Windows 新文件暂存发布 | 提供显式写授权/只读预检、同目录候选、排他硬链接发布、最终回读与失败/取消清理 | 独立测试目录与新文件请求 | 共享 FileOutcome 与独立清理状态/残留 | WP-009；原生授权不持久化，无覆盖/删除或 HTTP；WP-005 负责整批编排 | apps/desktop/src/main/new-file-publisher.ts、publication-errors.ts、目录原生定位及测试 |
| Android SAF 读取适配 | 负责只读授权/恢复、当前层元数据、原生读流，API 33/35 读取验证通过 | 系统选择结果、本地目录引用 | 当前条目、原生 InputStream 和能力/错误 | WP-003；Java、SAF、ContentResolver | apps/mobile 原生插件；apps/mobile/README.md |
| Android SAF 新文件写入 | 提供系统/进程授权分离、只读预检、新身份核实、非截断原生写流/最终回读和残留清理 | 已登记独立目标根/已有父目录、单文件请求及已验证私有原文流 | PublicationModel.Result 与 PublicationJson 单文件 outcome/cleanup，URI 留原生层 | WP-010；依赖 WP-003，供 WP-006 聚合；不恢复旧任务或覆盖/重命名 | apps/mobile Java NewFilePublisher、PublicationModel/Json、SafPublicationBackend、SafDirectoryStore 及测试 |
| Windows 私有归档 | 负责源快照/变化检查、受限 USTAR/gzip1 编解码、完整计数/哈希/结束校验和缓存所有权/取消清理 | 本次源引用或清单/归档流、可选 signal/进度回调 | 主进程私有只读流句柄、实测清单；完整验证后返回，不发布目标 | WP-012；Windows 读取/共享批量模型；固定夹具供 Java 复用 | apps/desktop/src/main/archive-*.ts、独立合成夹具 |
| Android Java 私有归档 | 负责原生源快照、未知长度实测/变化检查、严格 USTAR/gzip1、计数/取消/期限与缓存所有权及清理重试 | 本次 SAF 原生源引用或固定 v1 原生清单/归档流 | 完整校验后仅原生持有的不可变清单和私有只读句柄 | WP-013；复用 Android 读取及独立固定夹具，JVM/设备与 Windows 原生互通；不写 SAF 目标 | apps/mobile Java Archive*.java、SafArchiveSource.java 及测试；移动 README |
| Windows HTTP 读取与任务注册 | 提供显式服务启停/会话、目录、异步下载/单次 content、状态/取消、期限与清理；默认不监听 | 经验证的引用、本次集合 | 设备/会话描述、当前层、tar.gz 流及 sender 实际状态 | WP-004；Windows 读取、共享批量模型与 WP-012 | apps/desktop/src/main/http-*.ts、transfer-registry.ts、index.ts、HTTP 集成测试 |
| Windows HTTP 接收 | 提供上传预检/单次 PUT、压缩体确认及异步完整归档校验后非覆盖发布，管理 receiver 状态/取消/期限/清理 | 清单、逐项目标引用、tar.gz 原生流 | 逐文件实际结果、进度及残留 | WP-005；WP-004/WP-009/WP-012；接收能力与本机根写授权分开 | apps/desktop/src/main/upload-receiver.ts、http-*.ts、transfer-registry.ts、test/http-receiver.test.mjs |
| Android 原生传输 | 负责严格 HTTP/JSON/会话上下文、双向归档编排、全校验后逐项发布、实际进度/显式取消与持续通知 | 公开本地/远端引用、本次集合、手动地址与方向 | sender/receiver 分开的实际状态及清理；current 可重新取得同任务 | WP-006；复用归档/发布；Activity 不拥有任务，不添加自动后台同步 | Java Transfer*.java、HttpTransfersPlugin、TS 桥；移动 README |
| 最小验证界面 | 目录与元数据、服务状态、手动连接和双向传输操作 | 当前状态与用户操作 | 受限本地桥调用；源目标及结果展示 | WP-007；桌面 antd、移动 antd-mobile | apps/desktop renderer、apps/mobile/src |

目录配置与地址分别保存；Windows 使用稳定设备 ID、本地根目录引用和受限路径解析，Android 保存 SAF 引用与实际持久权限。界面不接收完整文件内容，大小未知/读取失败/不存在分别展示，目录不做递归汇总。

M-001 的范围是目录、归档和传输能力；同步算法、项目管理、备份、镜像、自动发现和 Windows 发起控制通道在后续里程碑实现。后续工作复用已经验证的适配器；归档往返通过后，完整同步仍按产品验收检查。
