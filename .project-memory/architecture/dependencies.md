---
doc_type: architecture-dependencies
status: draft
updated: 2026-11-09
tags: [依赖]
related_files: []
---

# 架构依赖

| 依赖 | 用途 | 约束 | 风险 | 状态 |
| --- | --- | --- | --- | --- |
| `@homebridge/ciao` 1.3.12（MIT） | 电脑端 mDNS / DNS-SD 广播 | 固定版本，由 electron-vite 打进 `out/main`；间接依赖 debug、tslib、source-map-support、fast-deep-equal。导入时会执行 `source-map-support/register`，改写主进程的错误堆栈格式 | 网卡绑定失败时只打印日志，不报错，因此广播状态显示 `advertising` 也不保证每块网卡都在广播；升级后要重新运行 `pnpm security:npm` 并复测广播 | active |
| `qrcode.react` 4.2.0（ISC） | `@savedata-sync/shared/ui` 的 `ConnectionQr` 渲染连接二维码（SVG） | 固定版本；shared 列为 peer 依赖，桌面和移动端各自安装；只导入 react，没有运行时依赖和安装脚本。纠错级别 M；SVG 底色透明、模块用 `currentColor`，外层底色用卡片色 `group`、文字色用正文色 `fg`：浅色主题白底深色码，深色主题深底浅色码（反色）（SVG 的 fill 属性不认 CSS 变量） | 加入时 `pnpm audit` 没有新增公告；升级后重新审计，并用扫码核对载荷 | active |
| `androidx.camera` 1.5.3（Apache-2.0） | Android 扫码的取景和取帧（camera-camera2、camera-lifecycle、camera-view） | 固定版本，取景画面用 `PreviewView` 的 TextureView 模式放在透明的 WebView 下面。camera-video 1.6 依赖完整的 Guava，和 `dependency-security.json` 固定的 listenablefuture 1.0 类重复，APK 构建失败，所以停在 1.5 | 升级后运行 `pnpm security:android`，并用真机复测扫码 | active |
| `com.google.zxing:core` 3.5.4（Apache-2.0） | Android 扫码的二维码解码 | 固定版本，没有运行时依赖。没选 ML Kit：它的官方披露写明会上传设备、应用和性能数据，没有查到关闭开关，本应用只走局域网。必须用 `MultiFormatReader` 的 `decodeWithState`：`ALSO_INVERTED` 只在这个类里生效，`decode` 会清掉选项 | 低光、倾斜和远距离下的识别能力没有和 ML Kit 对比过；识别率不够时再评估换库 | active |

模块划分见[架构总览](overview.md)，各模块的代码位置见[代码地图](../development/code-map.md)；本表只登记需要额外说明约束的外部库。
