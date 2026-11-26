---
doc_type: adr
status: accepted
updated: 2026-11-26
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

accepted。电脑和 Android 都实现了两种角色。依赖 `bonjour-service` 随本文接受，其他新增依赖由维护者另行同意。

## 替代关系

| 被替代 ADR | 原路径 | 原因 |
| --- | --- | --- |
| 无 | 无 | 新决策；实现 REQ-022，落实 Q-018、Q-019 的结论 |

## 背景

REQ-022 要求任意两台设备之间都能互传，包括电脑与电脑、Android 与 Android。按平台分工（一种平台只监听、另一种只拨号）只能支持电脑与 Android 之间的一种组合；按平台命名的方向和两端（如 `windows-to-android`、`pc`、`phone`）在同平台的两台设备之间分不清哪一端。

## 决策

### 角色与职责

1. 监听方运行 HTTP 服务和 `/v1/control`，广播 DNS-SD，显示连接二维码；拨号方从发现列表、扫码（只在移动端）或手动 IP 连接。两端平台不限。
2. 拨号方编排传输：扫描两端、算计划、在监听方登记任务、上传或下载内容、读取结果。监听方只按请求执行。
3. 监听方发起传输时，经控制通道发 `sync.prepare`、`sync.confirm`、`sync.cancel` 给拨号方，由拨号方编排；任务观察用 `sync.job`、`sync.job.read`、`sync.job.cancel`。两种平台都能作为监听方发起。
4. 新角色只实现 `/v1/device`、`/v1/catalog`、`/v1/control`、`/v1/roots`、目录列举和 `/v1/sync/*`。

### 协议和版本

5. 计划方向取 `listener-to-dialer`、`dialer-to-listener` 和 `local-restore`。任务观察的两端和 `ErrorDevice` 取 `listener`、`dialer`。界面按两端设备名显示方向，如“<来源设备名> → <目标设备名>”，不写平台名。
6. `PROTOCOL_VERSION`（`apps/shared/src/protocol/contracts.ts`）同时是 `/v1/device` 的 `protocolVersion`、DNS-SD TXT 的 `v` 和二维码的 `v`。协议版本不同的设备在发现列表里显示为版本不同，扫码和手动连接在交换目录表前停下。
7. `/v1/sync/capabilities.schemaVersion`、`SyncJobState.schemaVersion` 和控制消息的 `v` 各自标明格式版本，取值见共享包；控制消息版本不同的设备连不上控制通道。
8. 按[项目约束](../requirements/constraints.md)的“兼容性”，协议只支持当前版本，两端一起更新。

### 一台设备一条连接

9. 任何设备同一时刻只有一条控制连接，或者作为监听方被一台设备连着，或者作为拨号方连着一台设备。
10. 拨号方连着别人时，本机监听服务可以继续运行和广播，但 `POST /v1/catalog` 返回 `busy`，升级 `/v1/control` 返回 403。`busy` 的提示不提平台，如“对方正连着别的设备，请先断开”。
11. 监听方有设备连着时，本机设备页的连接入口不可用，提示先断开当前连接。同一设备重连仍按 4002 取代旧连接。
12. 写入互斥不变：同一时间只有一个写入任务。

### Android 监听

13. HTTP 和 WebSocket 服务自己实现，不引入服务端库：阻塞 IO，每条连接一个线程，只支持 HTTP/1.1 的本协议需要的部分。
    - 请求：请求行、原始头列表（保留重复头，以便按现有规则拒绝）、`Content-Length` 或 chunked 请求体；请求行、头总大小和头数量设上限。
    - 响应：固定长度和 chunked 两种；内容 GET 边打包边发送。
    - WebSocket：同端口在 `/v1/control` 升级，先做与电脑相同的会话和设备检查，不满足返回 403；只收文本帧，处理分片、掩码、ping/pong 和关闭码，单条最多 8 MiB。
    - `SyncScanner`、`SyncWriter`、`ArchiveAdapter`、`BackupStore` 直接读写请求体和响应体的 `InputStream`、`OutputStream`。
14. 本机服务开着时由前台服务 `ListenerService` 保持，类型为 `connectedDevice`，声明 `FOREGROUND_SERVICE_CONNECTED_DEVICE` 和满足该类型要求的 `CHANGE_WIFI_MULTICAST_STATE`；常驻通知显示服务地址和当前连接，带“停止”操作。应用退到后台或 Activity 销毁不停止，用户关掉开关或点通知里的“停止”才停。
15. 服务开关不保存，只反映本进程里服务是否在运行。进程结束后服务不由系统重启（`START_NOT_STICKY`），再打开应用时服务保持关闭，由用户重新打开；不开机启动。服务开关默认关闭。1.1.0 及以前保存在 SharedPreferences `local-service` 里的 `enabled` 键不再读写，也不清理。
16. 监听端的传输同样由 `TransferService`（dataSync）和进度通知保持。
17. 端口规则与电脑相同：首次生成 49152 到 65535 的随机端口并保存，可在服务停止时换一个。广播用 NsdManager 注册 `_savedata-sync._tcp`，TXT 与电脑相同；停止服务时注销。连接二维码复用 shared 的载荷和渲染。

### 电脑拨号

18. 电脑的拨号编排用 TypeScript 实现，和监听方共用扫描、写入、归档和备份模块；HTTP 客户端用 Node 内置的 `node:http`，以便控制 chunked 上传和逐块读取下载；控制通道客户端用 `ws`。
19. 局域网搜索引入 `bonjour-service`（基于 `multicast-dns`），只在设备页“连接其他设备”可见时搜索。广播仍用 `@homebridge/ciao`。
20. 电脑不提供扫码，按 REQ-012。

## 原因

- 只有监听方有 HTTP 服务，内容只能由拨号方上传或下载，所以编排放在拨号方，内容通道只有一种。
- 方向和端按角色命名，四种组合用同一套模型和校验；界面用设备名，电脑与电脑、Android 与 Android 都能分清两端。
- 应用分不清进程是被系统回收，还是用户从最近任务划掉了应用（不少系统划掉即结束进程）。本机服务会在局域网里监听和广播，进程结束后自动恢复会在用户不知情时重新开放；保持关闭的代价只是用户多开一次开关。
- `PROTOCOL_VERSION` 放进发现信息和二维码，版本不同的设备在发现和扫码阶段就被标出，不会连上后在创建任务时才报“请更新两端”。
- Android 服务端自己实现：协议面小且固定，协议规则要求原始头和严格的长度、编码检查；原生模块都基于阻塞流，阻塞服务端可以直接复用；同一时刻只有一个对端，不需要异步并发；不增加依赖，APK 没开代码压缩，不会因此变大。
- `connectedDevice` 没有时间上限；目标 API 35 及以上时，dataSync 在 Android 15 起每 24 小时最多运行 6 小时（本项目目标 API 36），不适合常驻监听，只留给传输。
- 一台设备一条连接，设备页、在线状态和写入互斥都只按一条连接设计。

## 影响

### 正面影响

- 任意两台设备之间都能互传，只有一套协议。

### 负面影响

- 两套编排和两套接纳端分别在 TypeScript 和 Java 里各维护一份，规则改动要两边同步。
- Android 多一份要维护的 HTTP 和 WebSocket 解析代码，需要 JVM 单元测试覆盖解析边界。
- 协议版本不同的设备不能互连，要两端一起更新。
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
| `apps/desktop/src/backend/http-service.ts`、`sync-registry.ts`、`remote-sync-requests.ts`、`control-hub.ts` | 电脑的监听方 |
| `apps/mobile/android/app/src/main/java/io/github/galgame/savedatasync/SyncTransferEngine.java`、`ControlClient.java`、`DiscoveryBrowser.java` | Android 的拨号方 |
| `apps/desktop/src/backend/dialer-session.ts`、`dialer-sync.ts`、`discovery-advertiser.ts`、`discovery-browser.ts` | 电脑的拨号方、广播和搜索 |
| `apps/mobile/android/app/src/main/java/io/github/galgame/savedatasync/Listener*.java`、`TransferService.java` | Android 的监听方和传输前台服务 |
