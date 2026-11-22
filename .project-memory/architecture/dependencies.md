---
doc_type: architecture-dependencies
status: draft
updated: 2026-11-22
tags: [依赖]
---

# 架构依赖

| 依赖 | 用途 | 约束 | 风险 | 状态 |
| --- | --- | --- | --- | --- |
| `@homebridge/ciao` 1.3.12（MIT） | 电脑端 mDNS / DNS-SD 广播 | 固定版本，由 `vite.sidecar.config.ts` 打进 `out/sidecar/index.mjs`；间接依赖 debug、tslib、source-map-support、fast-deep-equal。导入时会执行 `source-map-support/register`，改写 sidecar 的错误堆栈格式 | 网卡绑定失败时只打印日志，不报错，因此广播状态显示 `advertising` 也不保证每块网卡都在广播；升级后要重新运行 `pnpm security:node` 并复测广播 | active |
| `bonjour-service` 1.4.4（MIT） | 电脑端在局域网搜索其他设备（`discovery-browser.ts`） | 固定版本，由 `vite.sidecar.config.ts` 打进 `out/sidecar/index.mjs`；间接依赖 multicast-dns、fast-deep-equal。构造 `Bonjour` 时必须传错误回调，默认回调直接抛错会让 sidecar 出现未捕获异常。和 ciao 广播在同一进程同时使用 UDP 5353 | 升级后要重新运行 `pnpm security:node` 并复测搜索 | active |
| Tauri 2（MIT 或 Apache-2.0）：`tauri`、`tauri-build`、`tauri-plugin-dialog`、`tauri-plugin-opener`、`tauri-plugin-single-instance` crate，`@tauri-apps/api` 2.12.5、`@tauri-apps/cli` 2.12.6 | 电脑端宿主、系统 WebView、目录选择器、打开文件夹、单实例 | crate 在 `Cargo.toml` 写主版本 2，具体版本由 `Cargo.lock` 固定；npm 包固定版本。页面只用 `@tauri-apps/api` 的 `invoke` | 系统 WebView 的版本由系统决定；Rust 依赖不在 `pnpm security:node` 的审计范围里 | active |
| `qrcode.react` 4.2.0（ISC） | `@savedata-sync/shared/ui` 的 `ConnectionQr` 渲染连接二维码（SVG） | 固定版本；shared 列为 peer 依赖，桌面和移动端各自安装；只导入 react，没有运行时依赖和安装脚本。纠错级别 M；SVG 底色透明、模块用 `currentColor`，外层底色用卡片色 `group`、文字色用正文色 `fg`：浅色主题白底深色码，深色主题深底浅色码（反色）（SVG 的 fill 属性不认 CSS 变量） | 加入时 `pnpm audit` 没有新增公告；升级后重新审计，并用扫码核对载荷 | active |
| `androidx.camera` 1.5.3（Apache-2.0） | Android 扫码的取景和取帧（camera-camera2、camera-lifecycle、camera-view） | 固定版本，取景画面用 `PreviewView` 的 TextureView 模式放在透明的 WebView 下面。camera-video 1.6 依赖完整的 Guava，和 `dependency-security.json` 固定的 listenablefuture 1.0 类重复，APK 构建失败，所以停在 1.5 | 升级后运行 `pnpm security:android`，并用真机复测扫码 | active |
| `com.google.zxing:core` 3.5.4（Apache-2.0） | Android 扫码的二维码解码 | 固定版本，没有运行时依赖。没选 ML Kit：它的官方披露写明会上传设备、应用和性能数据，没有查到关闭开关，本应用只走局域网。必须用 `MultiFormatReader` 的 `decodeWithState`：`ALSO_INVERTED` 只在这个类里生效，`decode` 会清掉选项 | 低光、倾斜和远距离下的识别能力没有和 ML Kit 对比过；识别率不够时再评估换库 | active |

| 封面来源接口：VNDB（`api.vndb.org/kana`）、Bangumi（`api.bgm.tv/v0`）、Steam（`store.steampowered.com/api`）、NextMoe（`api.nextmoe.dev/v2/catalog`） | 游戏封面搜索和下载（REQ-024），应用里唯一访问外网的功能 | 都不登录调用。VNDB 请求间隔 1.55 秒；NextMoe 不登录每分钟 30 次，请求间隔 1.3 秒；下载图片时带上来源网站的 Referer。搜索请求和结果解析放在共享包，HTTP 请求和下载由各端原生层执行，Android WebView 直接请求会被跨域限制拦下 | 接口和限流由第三方决定，变更后搜索失败；实现前重新核对各接口 | planned |

模块划分见[架构总览](overview.md)，各模块的代码位置见[代码地图](../development/code-map.md)；本表只登记需要额外说明约束的外部库。
