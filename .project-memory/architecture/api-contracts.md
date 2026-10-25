---
doc_type: api-contracts
status: active
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
- [3. Windows HTTP 接口约定](#3-windows-http-接口约定)
- [4. 本地桥与错误边界](#4-本地桥与错误边界)
- [5. 版本与线格式](#5-版本与线格式)
- [6. 已实现检查与验证边界](#6-已实现检查与验证边界)

## 1. 状态与范围

版本 1 共享契约、Windows 本地目录读取和 Java SAF 读取适配已实现；Android API 33 与旧 API 35 分别完成读取及授权恢复验证，HTTP 与写入尚未实现。平台说明见 `apps/desktop/README.md`、`apps/mobile/README.md`，共享字段与线格式见 `packages/shared/README.md`；范围与依赖见[工作包](../development/work-packages.md)。

M-001 只验证专用测试目录内的新文件往返，不包含同步项目 CRUD、覆盖、镜像删除、备份、mDNS 或 Windows 发起任务的控制通道。Windows 为服务端，Android 原生层为 HTTP 客户端。

用户已在[Q-008](../requirements/open-questions.md)确定双向统一采用 tar.gz，作为唯一传输方案。按本次当前状态的待传集合合批，经 HTTP 原生流传输；接收端验证归档并逐项校验内容后发布，保留文件级结果与残留说明。批次上限、清单字段、压缩参数及任务/文件进度语义须在实现前细化。

独立调试协议已在真实 LAN 完成 54 组双向与 SAF 写后回读实验，结果见 `docs/experiments/transfer-benchmark-2026-10-26.md`。实验未交付正式批量端点或归档接收适配；现有版本 1 共享类型和线格式是已实现事实，须按上述决定修订，不能直接作为后续传输实现规格。

## 2. 共用数据语义

| 模型 | 当前字段与约束 |
| --- | --- |
| DeviceDescriptor | protocolVersion=1、deviceId、displayName、platform、capabilities；稳定 ID 与地址分离 |
| DirectoryReference | rootId、deviceId、displayName、authorization；授权状态 granted/expired/unavailable/unverified，不包含绝对路径或 content URI |
| EntryMetadata | rootId、entryId、parentId、name、kind、sizeBytes、modifiedAt、capabilities；file/directory 联合；根层 parentId=null，不能自引用；文件夹大小恒为 null，文件未知大小为 null，空文件为 0 |
| DirectoryListing | rootId、parentId、observedAt、entries；成功空数组表示空目录；条目须属于同一根/层且 ID 不重复；错误用独立包络 |
| EntryCapabilities / DeviceCapabilities | 条目能力 canRead/canList/canCreate/canRename/canDelete；设备能力 canListRoots/canReadFiles/canReceiveFiles/canQueryTransfers/canCancelTransfers；各值 supported/unsupported/unknown |
| TransferProgress | transferId、direction、status=running、stage、bytesTransferred、totalBytes；阶段 preparing/transferring/verifying/publishing；总量未知为 null，已知时已传不能超出总量 |
| TransferReceipt / TransferResult | succeeded 必须携带实际字节、sha256 和最终文件 entry；failed 携带 error 与 residualEntry；cancelled 携带 residualEntry；unknown 只能使用 result-unknown 错误，不可当作失败或未写入 |
| OperationError / OperationResult | code、message、canRetry；互斥 success/value 与 error/error 包络；result-unknown 的 canRetry 必须为 false；错误消息由生产者脱敏 |
| DirectorySelectionResult | selected 携带 directory，cancelled 不携带目录或错误，error 携带错误；取消不清空既有有效引用 |
| CreateFileRequest | rootId、parentId、transferId、name、expectedSizeBytes、expectedSha256；新文件名按共同创建约束验证，未知长度为 null，无覆盖选项 |

M-001 不要求所有提供者保留源修改时间；写入后查询并展示目标实际元数据。同路径、同大小或同日期均不能替代内容校验。

## 3. Windows HTTP 接口约定

以下是 tar.gz 方案的职责边界，均未实现。归档下载/接收的正式路由、清单及结果 DTO 在契约设计包中确定。

| API | 方法 | 请求 | 响应 | 错误边界 | 工作包 |
| --- | --- | --- | --- | --- | --- |
| /v1/device | GET | 无 | 协议版本、设备身份与能力 | 版本不兼容时客户端停止文件操作 | WP-004 |
| /v1/roots | GET | 无 | 本机用户已经选择用于本次验证的根目录描述 | 不枚举其他主机目录 | WP-004 |
| /v1/roots/{rootId}/entries | GET | 可选 parentId；省略表示根层 | 当前层条目及读取时间 | 非法引用、目录失效、不可读与空目录分别表达 | WP-004 |
| tar.gz 批量下载（路由待设计） | 待设计 | 已选根及本次待传条目引用、任务清单 | tar.gz 原生字节流与本次逐项校验信息 | 非文件、条目消失、源变化、权限失败；流开始后失败由接收校验处理 | WP-004；先完成批量契约设计 |
| tar.gz 批量接收（路由待设计） | 待设计 | 已选目标根、任务清单及 tar.gz 原生字节流 | 逐文件实际结果、任务状态和残留说明 | 同名或重复任务冲突、校验失败、空间不足、断流、取消；M-001 禁止覆盖已有文件 | WP-005；先完成批量契约设计 |
| /v1/transfers/{transferId} | GET | 本次会话任务 ID | 运行阶段或实际结果 | 不存在/到期不等于未写入；须重读当前目标核实 | WP-005 |
| /v1/transfers/{transferId} | DELETE | 取消本次任务 | 实际取消或已发布结果 | 与发布竞争时如实返回结果；不删除已发布最终文件 | WP-005 |

路由参数、任务清单和归档条目都必须验证。parentId 是目录引用，name 只能是单个合法文件名；归档成员必须与本次清单一致，拒绝绝对路径、路径穿越、重复成员及链接越界，不能直接按归档路径写盘。Windows 解析引用时仍须校验真实根目录边界，拒绝符号链接/junction 越界；不接受主机绝对路径。共享守卫只检查数据，不替代平台权限、实际路径与名称竞争检查。

tar.gz 打包、传输与解包按有限缓冲流式处理，并限制压缩体、解包总量和成员数量，具体上限在契约设计中确定；未知文件长度允许实际计数，以逐文件哈希和归档正常结束共同验证。先暂存、校验，再以不替换已有文件的语义发布；实现必须验证“检查目标不存在到发布”之间的竞争，并准确反馈批次部分发布的结果，不承诺整批原子性。源哈希只在本次任务中使用，任务结束后不保留历史内容索引。

transferId 不表示历史同步基线。服务只维护本次会话的运行与短期终态，到期释放；服务重启后客户端重新读取当前文件，不自动重放旧任务。首个请求未到达、响应丢失或结果已到期均可能导致查询未知，不能凭未知结果再次覆盖目标。

## 4. 本地桥与错误边界

| 边界 | 允许传递的内容 | 禁止或限制 |
| --- | --- | --- |
| Electron preload（已实现） | chooseDirectory、listRoots、listDirectory；只接受 ID，返回公开 DTO；系统选择器在主进程执行 | 无 fs/shell/Node、绝对路径、内容或写入接口；校验登记窗口、主 frame 与精确 URL；退出移除 handler |
| Electron 主进程原生读取（已实现） | registerDirectory 登记系统选中路径，listDirectory 返回当前层，openFile 返回本进程只读流 | 配置独立存放，不保存历史清单；调用者消费或 destroy 流；逐段拒绝 symlink/junction，重查根/条目/句柄身份，不承诺恶意并发命名空间原子隔离 |
| Electron 后续服务（未实现） | WP-004/005 后再加入服务控制与传输状态；新文件发布先由 WP-009 完成 | 不能把本包目录读取当作 HTTP/文件传输或写入能力 |
| Capacitor Java SAF 插件（已实现，API 33/35 读取验证通过） | chooseDirectory/listRoots/listDirectory；READ 持久授权、当前层元数据和本地 ID | URI/documentId 留在原生层，不接收任意路径；写入能力均不支持；原生只读流由同包调用者消费并关闭，不将内容或 Base64 交给 JS |
| Android 后续能力（未实现） | WP-010 新文件写入、WP-006 原生 upload/download/cancel 及进度 | 先验证独立写入夹具，再接 HTTP；真实存档保持只读 |
| 生命周期 | Android 前台允许启动任务；离开前台取消；返回后重新核实当前目录 | 不创建后台服务、不恢复旧任务继续传输；发布竞争按真实结果反馈 |

错误覆盖非法输入、版本不符、权限失效、不存在、不可读、不支持、名称冲突、路径越界、源变化、校验失败、网络失败、存储不足、IO/清理失败和结果待确认。未知属性属于成功读取中的 null；选择取消和任务取消属于独立结果，不伪造为读取错误。

## 5. 版本与线格式

本节记录已实现共享包的版本 1 线格式及校验事实；传输相关的单文件请求、响应、头名和状态需要适配 tar.gz 批量契约，不作为当前后续开发的候选协议。复用能力和兼容性须在正式契约修订中明确。

- 协议只接受数字版本 1，封闭 DTO 拒绝缺失和额外字段；不兼容字段或语义需新版本。ID 为 1–128 个 ASCII 字符，首位字母或数字，后续允许字母、数字、下划线和短横线，不接收路径或 URI。
- 字节数为非负安全整数；时间是 ±8.64e15 范围内的 Unix 毫秒整数，0 和负数有实际含义，未知修改日期用 null。文本非空白且最长 1024 个 UTF-16 码元。
- 新文件名最长 255 个 UTF-16 码元，拒绝路径字符、控制字符、未配对代理项、Windows 保留名和尾部点/空格；不静默改名或归一化。内容哈希固定 64 个小写十六进制字符，只用于当前任务。
- JSON 使用 OperationResult 包络。读取/查询返回 200；PUT 发布校验成功后返回 201 与 CreateFileResponse。查询成功仅表示取得 TransferState，仍要检查其任务状态。下载成功为原始流；下载前出错返回 JSON 错误，流开始后由接收校验和结果核实处理。
- 上传 name、可选 parentId 使用 UTF-8 查询参数；省略 parentId 表示 null。x-expected-sha256 必填，x-expected-size-bytes 可选，下载使用 x-content-sha256。长度头为非负十进制安全整数，无头表示 null；解码一次，拒绝歧义重复参数/头及非法编码。后续 HTTP 包实现解析与流处理。
- 错误映射由 HTTP_ERROR_STATUS 固定：非法请求 400；协议/名称/源变化冲突 409；权限/不可读/越界 403；不存在和结果未知 404；校验失败 422；不支持 501；存储不足 507；IO/清理失败 500。network-failure 是本地错误，映射为 null，不伪造 HTTP 响应。
- canRetry 仅允许核实当前状态后的用户新操作，不授权自动重放；unknown 不承诺远端未写入。取消与发布竞争返回实际观察，不要求远端已完成文件自动回滚。

## 6. 已实现检查与验证边界

packages/shared 提供 isDeviceDescriptor、isDirectoryReference、isEntryReference、isEntryMetadata、isDirectoryListing、isOperationError、isOperationResult、isDirectorySelectionResult、isTransferProgress、isTransferResult、isTransferState 和 isCreateFileRequest；协议辅助守卫检查版本、ID、哈希和创建文件名。

守卫仅校验已解析 JSON/plain data，不执行文件、网络、哈希计算、生命周期控制或脱敏，不改变/克隆/冻结输入；平台负责资源所有权、释放、线程隔离及原生异常到错误码的映射。跨 Java/JS 的超范围整数在原生侧拒绝，未知属性显式输出 null；SAF 日期 0 依提供者约定转换为未知。调用示例及桥生命周期说明见 `packages/shared/README.md`、`apps/mobile/README.md`。

运行时契约测试、只读/联合类型反例、移动桥、严格类型与双端构建均纳入 pnpm check；pnpm android:test 执行 Java 单元、lint 和两个 APK 编译。实际 SAF 设备证据见回归状态；HTTP、传输前台中断与完整产品仍待验证，不能将共享守卫通过当作产品验收通过。

Windows 目录与 IPC 的 15 项测试已通过，并在用户授权的真实目录完成只读原生流与配置恢复检查；前后内容哈希与修改时间一致。构建后的 CJS preload 隔离加载仅需 Electron 依赖。系统选择器人工交互及最终目录界面仍待界面包验证；真实目录禁止写入/删除/修改，测试配置与夹具独立存放，不保存真实路径或文件哈希。
