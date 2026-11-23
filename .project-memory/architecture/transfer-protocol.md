---
doc_type: architecture
status: active
updated: 2026-11-24
tags: [设备接口, tar.gz, HTTP]
---

# 设备接口与归档格式

## 目录

- [1. 适用范围](#1-适用范围)
- [2. 设备描述与固定上限](#2-设备描述与固定上限)
- [3. 归档格式](#3-归档格式)
- [4. HTTP 路由与会话](#4-http-路由与会话)
- [5. 依据与设计取舍](#5-依据与设计取舍)

## 1. 适用范围

本文规定监听方的设备描述、会话、目录浏览路由，以及复制内容使用的 tar.gz 归档格式和资源上限。复制任务（`/v1/sync/*`）的计划、收发顺序、写入和结果见[复制与备份约定](sync-copy.md)，控制通道和任务观察见[接口约定](api-contracts.md)。

复制内容不提交清单，也不带压缩体长度和哈希头：发送端按复制计划的文件顺序边读边打包，经 chunked HTTP 原生流发送；接收端边收边解包到私有缓存，核对每个成员与计划一致，完整性由 tar 头和 gzip 的 CRC32、ISIZE 保证。

## 2. 设备描述与固定上限

`GET /v1/device` 返回 `OperationResult<BatchDeviceDescriptor>`：`device: DeviceDescriptor`、`sessionId: ID`、`limits: BatchLimits`。`device.protocolVersion` 为 `PROTOCOL_VERSION`（数字 4），它同时是发现 TXT 和连接二维码的 `v`，版本不同的设备在发现和扫码时就标为版本不同。`DeviceCapabilities` 只有 `canListRoots`，报告目录浏览能力；复制能力由 `/v1/sync/capabilities` 报告。

`BatchLimits` 是两端相同的固定常量，不允许请求放宽：

| 上限 | 固定值 | 执行位置 |
| --- | --- | --- |
| maxFiles | 1,024 | 复制计划、归档收发 |
| maxFileBytes | 256 MiB = 268435456 | 复制计划、tar 头和实际解包计数 |
| maxTotalFileBytes | 1 GiB = 1073741824 | 复制计划、实际解包计数 |
| maxTarBytes | 1 GiB + 1 MiB = 1074790400 | 解压输出总计数，包含所有 tar 头、填充与结束块 |
| maxArchiveBytes | 1088 MiB = 1140850688 | 电脑接收复制内容的 HTTP 原始体 |
| maxJsonBytes | 8 MiB = 8388608；请求及单个 JSON 响应分别限制，解码前计 UTF-8 字节 | HTTP 解析及序列化、备份 JSON |
| maxConcurrentBatches | 1 | 只在描述里报告；复制和恢复的并发由进程写入名额限制 |
| maxTransfersPerSession | 4,096 | 每个服务会话已接纳的复制任务 ID |

另有两项不在描述里的资源上限（`BATCH_RESOURCES`）：每端私有缓存的文件总量最多 3 GiB（3221225472），应用显式文件读写缓冲每条最多 64 KiB，按文件流式读写，不把整批或整文件收进内存。这些是保守的技术预算，产品规模上限还没定。

## 3. 归档格式

归档采用受限 USTAR 格式，不接受任意用户 tar 文件：

1. 每个普通文件恰好一个 512 字节 USTAR 头，typeflag 固定 ASCII `0`；name 恰为 fileId（`f000001` 起按复制计划的文件顺序连续编号），余下 name 字节填零；prefix 和 linkname 全零。magic 为 `ustar` 加 NUL，version 为 `00`。拒绝链接、目录、设备、FIFO、PAX、GNU 长名、稀疏文件、base-256 数值和任何其他扩展。
2. mode 为八进制 0600，uid/gid/mtime 为 0，用户名/组名为空，设备字段为 0；归档不包含真实机器路径、属主或源时间。数值字段以非负 ASCII 八进制编码，发送端用零补齐并以 NUL 结束；checksum 使用六位八进制加 NUL、空格，计算时将该字段视为空格。接收端按计划的 fileId 和大小生成期望的头，逐字节比较。
3. 成员按计划顺序出现。size 必须等于计划里的文件大小，实际内容紧随头部并补零到下个 512 字节边界；填充必须为零。最后恰好两个全零块（1024 字节），不接受附加记录或隐藏成员。tar 总长为 `Σ(512 + ceil(sizeBytes / 512) × 512) + 1024`，不超过 maxTarBytes。
4. tar 外层为一个 gzip member：前 8 字节固定为魔数、CM=8、FLG=0、MTIME=0，不包含可选文件名、额外字段或注释；XFL/OS 不作为跨平台相等条件。发送端采用 gzip level 1；接收端只验证能否解码，无法从压缩字节可靠反推 level。接收端校验 DEFLATE 结束、CRC32、ISIZE，并要求输入恰好在 gzip 尾部结束；拼接的第二个 member、尾随字节、截断或损坏都报 invalid-archive。ISIZE 只作格式校验，超限判断使用实际计数。
5. 发送端读取每个文件前后核对大小和修改日期与计划一致，读到的字节数必须等于计划大小，否则报 source-changed。

接收端以 fileId 在自己创建的私有任务目录分配文件，tar name 不交给通用 extract-to-path API。通用解码器允许拼接 gzip 或忽略尾部数据，所以两端都自己处理 gzip 头尾：电脑用原始 DEFLATE 解码器，核对它实际消耗的字节数等于头尾之间的长度；Android 直接持有 `Inflater`，结束后回收未消耗的输入再读尾部。

## 4. HTTP 路由与会话

服务启动时生成新的不透明 sessionId，与稳定 deviceId 分离。除 `GET /v1/device` 外，所有请求都必须且只提供一个 `x-sync-session-id`，值精确匹配当前会话；这是重启检测标识，不是认证凭据。旧 sessionId 在服务重启后返回 409/session-mismatch。

| 方法和路径 | 输入 | 成功响应 |
| --- | --- | --- |
| GET /v1/device | 无 | 200，`OperationResult<BatchDeviceDescriptor>` |
| GET /v1/roots | 会话头 | 200，本机已选根目录列表的包络 |
| GET /v1/roots/{rootId}/entries | 会话头；可选 parentId，省略为根层 | 200，`DirectoryListing` 包络，只列当前层 |

目录表交换（`/v1/catalog`）、控制通道（`/v1/control`）和复制任务（`/v1/sync/*`）的路由见[接口约定](api-contracts.md)和[复制与备份约定](sync-copy.md)。未知路由返回 400/invalid-request。

JSON 使用 application/json，成功与错误均遵循互斥包络。复制内容的 gzip 是传输的文件表示，类型为 application/gzip，不设置 `Content-Encoding: gzip`；原生 HTTP 客户端不自动解压、不跟随重定向。不接受 Range、续传或 multipart。所有响应设置 `Cache-Control: no-store`。JSON 体按 maxJsonBytes 硬限计数，不接收 Content-Encoding；歧义定界失败并关闭连接。

路由 ID 和 parentId 只解码一次；拒绝未知或重复的查询参数、非法编码、附加路径段和错误 method。

## 5. 依据与设计取舍

gzip 格式的 header、DEFLATE、CRC32 和 ISIZE 依据 [RFC 1952](https://www.rfc-editor.org/rfc/rfc1952)。本格式主动限制为单 member、无可选头和无尾随内容，严格于通用 gzip 接收能力。

采用 gzip level 1 是本项目当前在速度、CPU 和体积之间的折中；全部设备上的表现还要实测。归档正确性由固定格式和跨端夹具验证（见[测试约定](../standards/testing.md)）。

归档成员名使用 fileId，文件名和目录留在复制计划里，避开跨平台 tar 文件名编码与路径展开。
