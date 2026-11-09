---
doc_type: work-packages
status: active
priority: high
owner: development
id_prefix: WP
id_high_water: 38
updated: 2026-11-09
tags: [工作包, M-002, M-003, 验收]
related_files:
  - docs/plans/m002-sync-copy.md
---

# 工作包登记

## 目录

- [1. 当前工作包](#1-当前工作包)
- [2. 执行与拆分规则](#2-执行与拆分规则)

## 1. 当前工作包

M-002 的规则、验收场景和结论见 `docs/plans/m002-sync-copy.md` 第 6 节。

M-003（连接与重连）的工作包如下。前提：

- 协议、数据模型和设备页按对称角色设计：任何设备都可能是监听方或拨号方，角色不按平台区分。M-003 只实现电脑监听、Android 拨号；Android 监听、电脑拨号和任意两台设备互传属于 M-005（REQ-022）。
- 扫码是唯一按平台区分的入口：只在移动端提供，桌面端不提供。桌面端作为拨号方时用发现列表和手动 IP；任何监听方都可以显示二维码。
- 发现列表、扫码和手动 IP 三个入口拿到地址后，都用 `/v1/device` 核对设备 ID；设备 ID 不一致时不替换已保存的设备。

| ID | 工作包 | 内容与完成标准 | 依赖 | 状态 |
| --- | --- | --- | --- | --- |
| WP-030 | 对称连接协议 | `apps/shared/src/connection` 定义 DNS-SD 服务类型、实例名（显示名）和 TXT 字段（协议版本、设备 ID、平台），二维码载荷（版本、设备 ID、端口、1–8 个候选 IPv4），以及候选地址转换，由监听方广播和显示，不限定平台。生成和解析函数、长期测试 `apps/shared/test/connection-discovery.test.mjs`，格式见[接口约定](../architecture/api-contracts.md)第 8 节。shared 测试和 `pnpm check` 通过 | — | done |
| WP-031 | 设备页原型 | 在 `docs/design/` 做双端可交互原型（不进 Git）。两端信息结构相同：本机作为监听方的部分（服务主开关、端口、推荐地址、二维码）和连接其他设备的部分（已保存设备、发现列表、扫码、手动 IP，以及连接、断开和管理；扫码只出现在移动端）。原型要标出 M-005 之前未实现的角色（Android 监听、电脑拨号）怎么呈现。维护者确认原型后才开始 WP-034。原型在 `docs/design/device-page-v3/`，用两端真实的外壳、组件和样式表，二维码是占位图。本机服务卡片在 `ServiceHero.tsx` 和 `proto-hero.css`，两端共用，按卡片自身宽度切换三档排版；在仓库根目录运行 `pnpm exec vite --config docs/design/device-page-v3/vite.config.ts`，总览页列出各状态，M-005 的样子单独标出，移动端画框可以切换手机和平板尺寸。依赖靠该目录下指向 `apps/mobile/node_modules` 的目录联接，重新创建原型目录时要补上。设备页的待定问题 [Q-014、Q-015](../requirements/open-questions.md) 已有结论，Q-016 改到 WP-036 开始前回答 | — | done |
| WP-032 | 电脑端 mDNS 广播 | `apps/desktop/src/main/discovery-advertiser.ts` 用 `@homebridge/ciao` 1.3.12（已审计并登记在[架构依赖](../architecture/dependencies.md)）在服务启动后广播、停止服务和退出应用时发 goodbye 包；端口变化要先停服务，重新启动时按新端口注册；网卡变化由 ciao 重新宣告。广播失败时 HTTP 服务照常运行，快照 `discovery` 显示失败并 30 秒重试。本机已用原始 mDNS 查询核对两块网卡上的 PTR、SRV、TXT、A 记录与 goodbye 包，`pnpm check` 通过。未验证：Portable 版 UDP 5353 防火墙放行（没有预置规则）、另一台设备实际搜到、注册失败后的重试分支、在 Electron 应用里启停服务 | WP-030 | in-review |
| WP-033 | Android NSD 搜索 | Java 插件封装 `NsdManager` 搜索和解析（API 34 以下逐个解析），通过 TS 桥返回设备 ID、名称和地址；只在需要时搜索，离开页面即停止。实现为 `DeviceDiscoveryPlugin`、`DiscoveryBrowser` 和 `src/platform/device-discovery.ts` 的 `deviceDiscovery.watch`，说明见移动 README“局域网设备搜索”。`pnpm check`、`pnpm android:test`（含 Android lint）通过。API 35 真机上搜到本机用 ciao 广播的三个测试服务：中文实例名、端口、IPv4、TXT 正确，goodbye 和广播结束后约 2 秒移除，回到桌面时暂停、回到前台后重新搜到，停止后系统 NsdService 的监听全部注销；桥用真机快照核对了合并、协议版本不同和订阅计数。未验证：API 34 以下的 resolveService 路径、网页重载时的停止、用桌面应用本身广播 | WP-030 | in-review |
| WP-034 | 设备页实现 | 按 WP-031 原型改造双端设备页：电脑端显示服务、推荐地址、二维码和广播状态；Android 端提供发现列表和手动 IP；发现列表只列未保存的设备，已保存的设备在附近搜到、且搜到的地址里有保存的地址时，在“已保存的设备”里标“在附近”（地址变了不标，改址交给 WP-036）。设备页文案按 M-005 角色对称后的说法写，不说“电脑”“手机”“移动端”，说“设备”“另一台设备”，M-005 之前读起来也不会错：`device.addPc` 改为“添加设备”，`device.emptyMobile` 改为“扫码或添加设备后连接”，`device.emptyPc` 改为“连接过的设备会出现在这里”，`device.waitingMobile` 改为“等待其他设备连接”；扫码提示“对准另一台设备上的二维码”，二维码弹窗标题“用另一台设备扫码连接”；电脑的添加按钮和游戏页一样放在“已保存的设备”标题右边。en-US 对应改写。移动端不显示本机服务部分（Q-014）；二维码按原型在卡片够宽时常驻、窄时收进按钮（Q-015）。二维码用 `qrcode.react` 4.2.0（ISC，无运行时依赖），已审计并登记在架构依赖。实现：服务卡片 `ServiceHero` 和 `ConnectionQr` 放在 shared/ui，桌面服务快照补了设备 ID、IPv4 候选地址和开始监听时间；电脑端“添加设备”按原型等 M-005 电脑能主动连接后再显示。两端已保存的设备按最近连接排序：每次新连接把设备移到列表开头，顺序随配置保存。Android 端设备名不能选中，长按已保存设备和点按一样打开管理（与游戏卡片共用 `components/use-long-press.ts`）。验证：`pnpm check`、test:desktop、test:shared 通过，`antd lint` 无问题；Android 13 手机连开发版 Electron 跑通搜索、连接、先断开提示、“在附近”标记、排序、长按和两端断开，详见回归记录。二维码底色用卡片色、模块用正文色：浅色主题白底深色码，深色主题深底浅色码（反色）。没有测：电脑端两台手机先后连接时的排序、协议版本不同的真实设备、电脑端深色主题的其余部分 | WP-031、WP-032、WP-033 | done |
| WP-035 | Android 扫码 | 申请相机权限、扫描页、解析载荷、依次尝试候选地址，设备 ID 一致才保存；拒绝相机权限时可去系统设置或手动输入。扫码库用 ZXing core 3.5.4 加 CameraX 1.5.3，选型原因见[架构依赖](../architecture/dependencies.md)，说明见移动 README“扫码连接”。监听方在深色主题下显示深底浅色码（反色），由 ZXing 的 `ALSO_INVERTED` 翻转重读。`pnpm check`、`pnpm android:test`（含 Android lint）、`pnpm security:android` 通过；解码类用生成的帧核对过正常码和反色码，浏览器预览核对了页面状态，真机通过相机取景、权限流程、电脑浅色和深色主题的二维码、扫码连接，详见回归记录。没有测：设备 ID 不一致时不保存、协议版本不同的二维码、平板旋转 | WP-030、WP-034 | done |
| WP-036 | 改址自动重连 | 已保存的设备连不上时按设备 ID 搜索，找到后更新地址并重连，目录映射保留；超时提示手动改址。确认 Android 地址变化后控制通道能重新拨号 | WP-033、WP-034 | planned |
| WP-038 | 全应用文案改成对称说法 | 设备页以外按平台称呼对方的文案也改成 M-005 角色对称后的说法：`transfer.remoteBusy`（“等待移动端开始”）、`transfer.remoteScanRequest`（“电脑请求扫描”）、`task.mobileToPc`、`task.pcToMobile`（“移动端 → 电脑”）、`error.onMobile`、`error.onPc`（“电脑上…”）。改成“本机”“对方设备”或对方的设备名，具体文案和是否改键名进入本包时定，zh-CN 和 en-US 一起改。改完界面文案里不再出现“电脑”“手机”“移动端” | WP-034 | planned |
| WP-037 | M-003 验收 | 补测试用例；真机验证电脑或 Android 改址、AP 隔离或屏蔽组播时退回手动改址、扫码、多网卡电脑；更新验收和回归状态 | WP-030～WP-036、WP-038 | planned |

建议顺序：WP-030、WP-031 → WP-032、WP-033 → WP-034 → WP-035、WP-036、WP-038 → WP-037。

## 2. 执行与拆分规则

- 一包承担一个主要能力边界。跨平台协议变更、提供者差异、无法独立验证或新增依赖/配置迁移使范围扩大时先拆包；保留原包交接，同一交付物只写在一个包。
- 实现前读取目标路径实际存在且适用的 `AGENTS.md`、项目编码规范和目标语言规则；桌面应用规则位于 `apps/desktop/AGENTS.md`，要求完整读取 `antd` skill。设计授权不包含实现或提交权限。
- 工作包完成以针对性检查、受影响工程检查和明确剩余缺口为证据；没有真机证据的项保持未完成。完成、阻塞和下一步同步 INDEX、模块状态、用例和回归状态。
- M-002 不做 Android 10 实测；M-003 每个工作包开始前、M-004 进入时重新读取记忆并细化。
- 不授权并行 Agent。
