---
doc_type: architecture-dependencies
status: draft
updated: 2026-11-23
tags: [依赖]
---

# 架构依赖

| 依赖 | 用途 | 约束 | 风险 | 状态 |
| --- | --- | --- | --- | --- |
| `@homebridge/ciao` 1.3.12（MIT） | 电脑端 mDNS / DNS-SD 广播 | 固定版本，由 `vite.sidecar.config.ts` 打进 `out/sidecar/index.cjs`；间接依赖 debug、tslib、source-map-support、fast-deep-equal。导入时会执行 `source-map-support/register`，改写 sidecar 的错误堆栈格式 | 网卡绑定失败时只打印日志，不报错，因此广播状态显示 `advertising` 也不保证每块网卡都在广播；升级后要重新运行 `pnpm security:node` 并复测广播 | active |
| `bonjour-service` 1.4.4（MIT） | 电脑端在局域网搜索其他设备（`discovery-browser.ts`） | 固定版本，由 `vite.sidecar.config.ts` 打进 `out/sidecar/index.cjs`；间接依赖 multicast-dns、fast-deep-equal。构造 `Bonjour` 时必须传错误回调，默认回调直接抛错会让 sidecar 出现未捕获异常。和 ciao 广播在同一进程同时使用 UDP 5353 | 升级后要重新运行 `pnpm security:node` 并复测搜索 | active |
| Tauri 2（MIT 或 Apache-2.0）：`tauri`、`tauri-build`、`tauri-plugin-dialog`、`tauri-plugin-opener`、`tauri-plugin-single-instance` crate，`@tauri-apps/api` 2.12.5、`@tauri-apps/cli` 2.12.6 | 电脑端宿主、系统 WebView、目录选择器、打开文件夹、单实例 | crate 在 `Cargo.toml` 写主版本 2，具体版本由 `Cargo.lock` 固定；npm 包写 `^` 范围，实际版本由 `pnpm-lock.yaml` 固定，`@tauri-apps/api` 和 `tauri` crate 的小版本要一致（见[编码约定](../standards/coding.md#格式与工具)）。页面只用 `@tauri-apps/api` 的 `invoke` | 系统 WebView 的版本由系统决定；Rust 依赖不在 `pnpm security:node` 的审计范围里 | active |
| `@yao-pkg/pkg` 6.26.0（MIT，固定 `@yao-pkg/pkg-fetch` 3.6.8）、`resedit` 3.1.0（MIT，间接依赖 pe-library） | 打包时生成 sidecar 可执行文件：pkg-fetch 下载预编译的 Node 22 基础二进制，resedit 替换版本信息，pkg 把 `out/sidecar/index.cjs` 打进去 | 电脑端开发依赖，只在 `apps/desktop/scripts/build-sidecar-exe.mjs` 使用。两者都写 `^` 范围，实际版本由 `pnpm-lock.yaml` 记录，`pnpm update` 就能升级到同主版本的最新版：pkg 的新版本带来新的 Node 补丁。pkg-fetch 从 pkg 的安装位置解析，保证和 pkg 期望的版本一致。没用 rcedit：它在 npm 上被标为不再支持 | 内嵌的 Node 由 pkg-fetch 预编译，只带英文区域数据（small-icu），sidecar 里依赖区域数据的接口只按英文工作；Node 安全补丁要等 pkg-fetch 发布新的基础二进制后升级 pkg 才能拿到；升级后重新打包并复测启动、服务和传输 | active |
| `qrcode.react` 4.2.0（ISC） | `@savedata-sync/shared/ui` 的 `ConnectionQr` 渲染连接二维码（SVG） | 固定版本；shared 列为 peer 依赖，桌面和移动端各自安装；只导入 react，没有运行时依赖和安装脚本。纠错级别 M；SVG 底色透明、模块用 `currentColor`，外层底色用卡片色 `group`、文字色用正文色 `fg`：浅色主题白底深色码，深色主题深底浅色码（反色）（SVG 的 fill 属性不认 CSS 变量） | 加入时 `pnpm audit` 没有新增公告；升级后重新审计，并用扫码核对载荷 | active |
| `androidx.camera` 1.5.3（Apache-2.0） | Android 扫码的取景和取帧（camera-camera2、camera-lifecycle、camera-view） | 固定版本，取景画面用 `PreviewView` 的 TextureView 模式放在透明的 WebView 下面。camera-video 1.6 依赖完整的 Guava，和 `dependency-security.json` 固定的 listenablefuture 1.0 类重复，APK 构建失败，所以停在 1.5 | 升级后运行 `pnpm security:android`，并用真机复测扫码 | active |
| `com.google.zxing:core` 3.5.4（Apache-2.0） | Android 扫码的二维码解码 | 固定版本，没有运行时依赖。没选 ML Kit：它的官方披露写明会上传设备、应用和性能数据，没有查到关闭开关，本应用只走局域网。必须用 `MultiFormatReader` 的 `decodeWithState`：`ALSO_INVERTED` 只在这个类里生效，`decode` 会清掉选项 | 低光、倾斜和远距离下的识别能力没有和 ML Kit 对比过；识别率不够时再评估换库 | active |
| 封面来源接口：VNDB（`api.vndb.org/kana`）、Bangumi（`api.bgm.tv/v0`）、Steam（`store.steampowered.com/api`、`api.steampowered.com/IStoreBrowseService`）、NextMoe（`api.nextmoe.dev/v2/catalog`） | 游戏封面搜索和下载（REQ-024），应用里唯一访问外网的功能 | 都不登录调用。VNDB 请求间隔 1.55 秒；NextMoe 不登录每分钟 50 次，请求间隔 1.3 秒；Bangumi 必须带 `User-Agent`。HTTP 请求和下载由各端原生层执行，Android WebView 直接请求会被跨域限制拦下，电脑端 CSP 不允许外网图片和请求。接口细节和模块划分见[游戏封面](poster.md) | 接口和限流由第三方决定，变更后搜索失败；接口事实是 2026-11-23 的实测结果；Steam 新游戏的封面路径带 hash，只能经 StoreBrowse 取得 | planned |

模块划分见[架构总览](overview.md)，各模块的代码位置见[代码地图](../development/code-map.md)；本表只登记需要额外说明约束的外部库。
