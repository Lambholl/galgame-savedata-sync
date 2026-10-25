---
doc_type: api-contracts
status: draft
priority: medium
owner: architecture
updated: 2026-10-26
tags: [API, 接口契约]
related_files: []
---

# 接口契约

## 目录

- [1. 状态与范围](#1-状态与范围)
- [2. 共用数据语义](#2-共用数据语义)
- [3. Windows HTTP 候选接口](#3-windows-http-候选接口)
- [4. 本地桥与错误边界](#4-本地桥与错误边界)

## 1. 状态与范围

以下是 M-001 的候选契约，尚未实现或批准为稳定接口。工作范围、依赖与详细设计入口见[工作包](../development/work-packages.md)。WP-001 评审时确定最终字段名、版本及状态码，再进入平台实现。

M-001 只验证专用测试目录内的新文件往返，不包含同步项目 CRUD、覆盖、镜像删除、备份、mDNS 或 Windows 发起任务的控制通道。Windows 为服务端，Android 原生层为 HTTP 客户端。

## 2. 共用数据语义

| 模型 | 候选字段与约束 |
| --- | --- |
| DeviceDescriptor | protocolVersion、稳定 deviceId、displayName、可用能力；地址是连接信息，不是身份 |
| DirectoryReference | 本地 rootId、所属 deviceId、显示名称及授权状态；绝对路径/content URI 仅在所属平台保存，不通过 HTTP 暴露 |
| EntryMetadata | rootId、entryId、parentId、name、kind、sizeBytes、modifiedAt、capabilities；ID 不透明；文件夹大小为 null，文件未知大小为 null；时间为毫秒时间戳或 null |
| DirectoryListing | entries、observedAt；成功的空数组表示空目录；失败必须返回独立错误，不能用空数组伪装 |
| Capabilities | 读取、列目录、创建、重命名、删除等能力分别表达支持/不支持/未知；不把目录授权等同于全部能力可用 |
| TransferProgress | transferId、显式方向、阶段、已传字节、总字节或 null；总量未知时不计算百分比 |
| TransferResult | 实际终态、实际字节、本次 SHA-256、最终条目或失败/残留说明；本次结果不能成为未来同步判定依据 |
| OperationError | 稳定错误码、可展示信息、是否可重试、必要的结果待确认/清理失败说明；不返回平台堆栈或敏感绝对路径 |

M-001 不要求所有提供者保留源修改时间；写入后查询并展示目标实际元数据。同路径、同大小或同日期均不能替代内容校验。

## 3. Windows HTTP 候选接口

| API | 方法 | 请求 | 响应 | 错误边界 | 工作包 |
| --- | --- | --- | --- | --- | --- |
| /v1/device | GET | 无 | 协议版本、设备身份与能力 | 版本不兼容时客户端停止文件操作 | WP-004 |
| /v1/roots | GET | 无 | 本机用户已经选择用于本次验证的根目录描述 | 不枚举其他主机目录 | WP-004 |
| /v1/roots/{rootId}/entries | GET | 可选 parentId；省略表示根层 | 当前层条目及读取时间 | 非法引用、目录失效、不可读与空目录分别表达 | WP-004 |
| /v1/roots/{rootId}/files/{entryId}/content | GET | 当前文件引用 | 原始字节流，预先计算的本次 SHA-256，已知时返回长度 | 非文件、条目消失、源变化、权限失败；流开始后失败由接收校验处理 | WP-004 |
| /v1/roots/{rootId}/transfers/{transferId} | PUT | parentId、单个新文件名；预期 SHA-256、可选预期长度；请求体为原始流 | 校验并发布后的 TransferResult | 同名或重复任务冲突、校验失败、空间不足、断流、取消；禁止覆盖已有文件 | WP-005 |
| /v1/transfers/{transferId} | GET | 本次会话任务 ID | 运行阶段或实际结果 | 不存在/到期不等于未写入；须重读当前目标核实 | WP-005 |
| /v1/transfers/{transferId} | DELETE | 取消本次任务 | 实际取消或已发布结果 | 与发布竞争时如实返回结果；不删除已发布最终文件 | WP-005 |

路由参数和请求元数据都必须验证。parentId 是目录引用，name 只能是单个合法文件名，不能包含路径分隔符或穿越片段；具体编码、长度及错误码映射在 WP-001 确定。Windows 解析引用时校验根目录边界，拒绝符号链接/junction 将访问导向根目录之外；不接受主机绝对路径。Renderer、HTTP 与 Android 桥分别执行输入验证，不能只依赖界面校验。

接收按有限缓冲流式处理；未知文件长度允许实际计数，以哈希和正常流结束共同验证。先暂存、校验，再以不替换已有文件的语义发布；实现必须验证“检查目标不存在到发布”之间的竞争。源哈希只在本次流传输中使用，任务结束后不保留历史内容索引。

transferId 不表示历史同步基线。服务只维护本次会话的运行与短期终态，到期释放；服务重启后客户端重新读取当前文件，不自动重放旧任务。首个请求未到达、响应丢失或结果已到期均可能导致查询未知，不能凭未知结果再次覆盖目标。

## 4. 本地桥与错误边界

| 边界 | 允许传递的内容 | 禁止或限制 |
| --- | --- | --- |
| Electron preload | 目录选择/恢复、当前层查询、服务启动/停止、订阅状态和传输结果 | 不暴露任意 fs、shell、Node 或任意路径接口 |
| Capacitor Kotlin 插件 | 目录选择/恢复、元数据、本地引用、原生 upload/download/cancel 及进度 | 内容流留在原生层；不将整文件或 Base64 交给 JS |
| 生命周期 | Android 前台允许启动任务；离开前台取消；返回后重新核实当前目录 | 不创建后台服务、不恢复旧任务继续传输；发布竞争按真实结果反馈 |

候选错误覆盖取消选择、权限失效、不存在、未知属性、不可读、不支持、名称冲突、路径越界、源变化、校验失败、网络失败、存储不足、清理失败与结果待确认。未知属性属于成功读取中的空值，不应自动导致整目录读取失败。状态码与原生错误映射由 WP-001 明确，不能在两个平台分别发明互不兼容的含义。
