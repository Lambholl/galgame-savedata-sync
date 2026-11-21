---
doc_type: adr
status: accepted
updated: 2026-11-22
tags: [决策, 连接, 传输, 监听方, 拨号方, Android, Windows]
---

# ADR-0004 按监听方和拨号方划分连接与传输职责

## 目录

- [状态](#状态)
- [替代关系](#替代关系)
- [背景](#背景)
- [决策](#决策)
  - [角色与职责](#角色与职责)
  - [协议和版本](#协议和版本)
  - [一台设备一条连接](#一台设备一条连接)
  - [Android 监听](#android-监听)
  - [电脑拨号](#电脑拨号)
- [原因](#原因)
- [影响](#影响)
  - [正面影响](#正面影响)
  - [负面影响](#负面影响)
- [替代方案](#替代方案)
- [相关文件](#相关文件)

## 状态

accepted。架构文档和术语表已按监听方和拨号方描述规则；共享模型已按角色命名；电脑和 Android 都已实现两种角色。本文列出的新依赖 `bonjour-service` 随本文接受；其他新增依赖由维护者另行同意。

## 替代关系

| 被替代 ADR | 原路径 | 原因 |
| --- | --- | --- |
| 无 | 无 | 新决策；实现 REQ-022，落实 Q-018、Q-019 的结论 |

## 背景

M-003 把发现、二维码和控制通道按对称角色设计，但实现只有一种组合：

- 电脑只会监听：`http-service.ts` 提供 HTTP 和 `/v1/control`，`sync-registry.ts` 接纳任务、收发内容，`remote-sync-requests.ts` 把电脑发起的传输经控制通道交给对方。
- Android 只会拨号：`SyncTransferEngine.java` 经 HTTP 扫描电脑、算计划、登记任务、上传或下载内容，并处理电脑发来的 `sync.prepare` 等请求；`ControlClient.java` 拨号控制通道。

共享模型按平台命名：方向是 `windows-to-android`、`android-to-windows`，任务观察的两端是 `pc`、`phone`，错误所在端 `ErrorDevice` 是 `phone`、`pc`。电脑与电脑、Android 与 Android 之间这些名字无法区分两端。

## 决策

### 角色与职责

1. 监听方运行 HTTP 服务和 `/v1/control`，广播 DNS-SD，显示连接二维码；拨号方从发现列表、扫码（只在移动端）或手动 IP 连接。两端平台不限。
2. 拨号方编排传输：扫描两端、算计划、在监听方登记任务、上传或下载内容、读取结果。监听方只按请求执行，现有电脑监听、Android 拨号的分工就是这条规则。
3. 监听方发起传输时，经控制通道发 `sync.prepare`、`sync.confirm`、`sync.cancel` 给拨号方，由拨号方编排；任务观察用 `sync.job`、`sync.job.read`、`sync.job.cancel`。消息和规则沿用现有电脑发起的流程，只是不再限定平台。
4. 新角色只实现 `/v1/device`、`/v1/catalog`、`/v1/control`、`/v1/roots`、目录列举和 `/v1/sync/*`。

### 协议和版本

5. 计划方向改为 `listener-to-dialer`、`dialer-to-listener`，`local-restore` 不变。任务观察的两端改为 `listener`、`dialer`；`ErrorDevice` 改为 `listener`、`dialer`。界面按两端设备名显示方向，如“<来源设备名> → <目标设备名>”，不再写“电脑”“Android”。
6. `PROTOCOL_VERSION` 从 1 升到 2。它同时是 `/v1/device` 的 `protocolVersion`、DNS-SD TXT 的 `v` 和二维码的 `v`，所以旧版设备在发现列表里显示为版本不同，扫码和手动连接也在交换目录表前停下。
7. `/v1/sync/capabilities.schemaVersion` 从 6 升到 7，`SyncJobState.schemaVersion` 从 4 升到 5。控制消息 `v` 保持 1：版本不同的设备连不上控制通道。
8. 按[项目约束](../requirements/constraints.md)的“兼容性”，不保留旧版方向值和旧版本的兼容代码。

### 一台设备一条连接

9. 任何设备同一时刻只有一条控制连接，或者作为监听方被一台设备连着，或者作为拨号方连着一台设备。
10. 拨号方连着别人时，本机监听服务可以继续运行和广播，但 `POST /v1/catalog` 返回 `busy`，和现在“另一台设备连着”的处理相同；升级 `/v1/control` 仍返回 403。`busy` 的提示文案改为不提平台，如“对方正连着别的设备，请先断开”。
11. 监听方有设备连着时，本机设备页的连接入口不可用，提示先断开当前连接。同一设备重连仍按 4002 取代旧连接。
12. 写入互斥不变：同一时间只有一个写入任务。

### Android 监听

13. HTTP 和 WebSocket 服务自己实现，不引入服务端库：阻塞 IO，每条连接一个线程，只支持 HTTP/1.1 的本协议需要的部分。
    - 请求：请求行、原始头列表（保留重复头，以便按现有规则拒绝）、`Content-Length` 或 chunked 请求体；请求行、头总大小和头数量设上限。
    - 响应：固定长度和 chunked 两种；内容 GET 边打包边发送。
    - WebSocket：同端口在 `/v1/control` 升级，先做与电脑相同的会话和设备检查，不满足返回 403；只收文本帧，处理分片、掩码、ping/pong 和关闭码，单条最多 8 MiB。
    - 现有 `SyncScanner`、`SyncWriter`、`ArchiveAdapter`、`BackupStore` 直接读写请求体和响应体的 `InputStream`、`OutputStream`。
14. 本机服务开着时由新的前台服务保持，类型为 `connectedDevice`，声明 `FOREGROUND_SERVICE_CONNECTED_DEVICE` 和满足该类型要求的 `CHANGE_WIFI_MULTICAST_STATE`；常驻通知显示服务地址和当前连接，带“停止”操作。应用退到后台或 Activity 销毁不停止，用户关掉开关或点通知里的“停止”才停。
15. 服务被系统结束后不自动重启（`START_NOT_STICKY`），开关保持开着，下次打开应用时重新启动；不开机启动。服务开关默认关闭。
16. 监听端的传输仍由现有 `TransferService`（dataSync）和进度通知保持，期限、取消和清理规则不变。
17. 端口规则与电脑相同：首次生成 49152 到 65535 的随机端口并保存，可在服务停止时换一个。广播用 NsdManager 注册 `_savedata-sync._tcp`，TXT 与电脑相同；停止服务时注销。连接二维码复用 shared 的载荷和渲染。

### 电脑拨号

18. 编排在主进程 TypeScript 实现，复用电脑现有的扫描、写入、归档和备份模块；HTTP 客户端用 Node 内置的 `node:http`，以便控制 chunked 上传和逐块读取下载；控制通道客户端用已有的 `ws`。
19. 局域网搜索引入 `bonjour-service`（基于 `multicast-dns`），只在设备页“连接其他设备”可见时搜索。广播仍用 `@homebridge/ciao`。
20. 电脑不提供扫码，按 REQ-012。

## 原因

- 只有监听方有 HTTP 服务，内容只能由拨号方上传或下载，所以编排放在拨号方是唯一不改内容通道的做法；现有 Android 引擎和电脑接纳端各自成为一个角色的参照实现。
- 方向和端按角色命名后，四种组合用同一套模型和校验；界面改用设备名，电脑与电脑、Android 与 Android 都能分清两端。
- 升 `PROTOCOL_VERSION` 让版本不同的设备在发现和扫码阶段就被标出，不会连上后在创建任务时才报“请更新两端”。
- Android 服务端自己实现：协议面小且固定，现有规则本来就要求原始头和严格的长度、编码检查；现有原生模块都基于阻塞流，阻塞服务端可以直接复用；同一时刻只有一个对端，不需要异步并发；不增加依赖，APK 没开代码压缩，不会因此变大。
- `connectedDevice` 没有时间上限；目标 API 35 及以上时，dataSync 在 Android 15 起每 24 小时最多运行 6 小时（本项目目标 API 36），不适合常驻监听，只留给传输。
- 一台设备一条连接沿用现有“只允许一台设备在线”的规则，设备页、在线状态和写入互斥都不用按两条连接设计。

## 影响

### 正面影响

- 电脑与电脑、Android 与 Android、Android 监听与电脑拨号三种新组合可用，且只有一套协议。
- 现有电脑监听、Android 拨号的流程不变，只换命名和版本号。

### 负面影响

- 两套编排和两套接纳端分别在 TypeScript 和 Java 里各维护一份，规则改动要两边同步。
- Android 多一份要维护的 HTTP 和 WebSocket 解析代码，需要 JVM 单元测试覆盖解析边界。
- 旧版设备与新版之间不能互连，要两端一起更新。
- Android 开着本机服务时多一条常驻通知，耗电增加。

## 替代方案

| 方案 | 优点 | 缺点 | 结果 |
| --- | --- | --- | --- |
| 发起方编排，两端都运行 HTTP 服务 | 编排只跟发起方走 | 拨号方也要开服务、对方要能连回来，连接模型从一条变成两条 | rejected |
| Android 用 NanoHTTPD | 小、阻塞模型 | 多年没维护；头放进 Map 会合并重复头；不解码 chunked 请求体 | rejected |
| Android 用 Netty | 解析成熟，自带 chunked 和 WebSocket | 异步模型要给现有阻塞流做背压适配；依赖大，APK 没开代码压缩 | rejected |
| 控制通道在 Android 另开端口，用 Java-WebSocket 的服务端 | 不用自己写 WebSocket | 发现和二维码只带一个端口，要改协议；HTTP 部分仍要另写 | rejected |
| 本机服务只在应用打开时监听 | 不需要常驻通知 | 对方连接前要先在 Android 上打开应用 | rejected（Q-018） |
| 允许同时监听和拨号 | 一台设备能同时连两台 | 设备页、在线状态和写入互斥都要按两条连接设计 | rejected（Q-019） |

## 相关文件

| 文件 | 说明 |
| --- | --- |
| `apps/shared/src/sync/`、`apps/shared/src/protocol/contracts.ts`、`apps/shared/src/control/` | 方向、任务观察、`ErrorDevice`、版本号 |
| `apps/desktop/src/main/http-service.ts`、`sync-registry.ts`、`remote-sync-requests.ts`、`control-hub.ts` | 监听方参照实现，Android 监听按此移植 |
| `apps/mobile/android/app/src/main/java/io/github/galgame/savedatasync/SyncTransferEngine.java`、`ControlClient.java`、`DiscoveryBrowser.java` | 拨号方参照实现，电脑拨号按此移植 |
| `apps/desktop/src/main/discovery-advertiser.ts` | 电脑广播，新增搜索与它并存 |
| `apps/mobile/android/app/src/main/java/io/github/galgame/savedatasync/TransferService.java` | 传输前台服务，监听服务另建 |
