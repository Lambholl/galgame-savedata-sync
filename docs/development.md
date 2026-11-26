# 开发指南

本文档面向参与本项目开发、构建与发布的开发者。应用使用说明见[根目录 README](../README.md)，架构设计、接口约定与当前状态见[项目记忆](../.project-memory/INDEX.md)。

## 目录

- [快速开始](#快速开始)
- [环境要求](#环境要求)
  - [工具版本](#工具版本)
  - [Linux 环境准备](#linux-环境准备)
  - [本机工具路径](#本机工具路径)
- [常用命令](#常用命令)
- [仓库结构](#仓库结构)
- [桌面端打包](#桌面端打包)
  - [后端 sidecar](#后端-sidecar)
  - [Windows](#windows)
  - [Linux](#linux)
- [Android 构建与调试](#android-构建与调试)
  - [用 Chrome 检查页面](#用-chrome-检查页面)
  - [加载电脑上的开发服务器](#加载电脑上的开发服务器)
- [真机调试工具](#真机调试工具)
  - [诊断与故障注入](#诊断与故障注入)
  - [frida](#frida)
- [Android 签名](#android-签名)
  - [生成密钥](#生成密钥)
  - [本机配置](#本机配置)
  - [GitHub Actions 配置](#github-actions-配置)
  - [密钥丢失或泄露](#密钥丢失或泄露)
- [兼容性与卸载](#兼容性与卸载)
  - [数据兼容性与迁移](#数据兼容性与迁移)
  - [存储目录与卸载影响](#存储目录与卸载影响)
- [版本号与发布](#版本号与发布)
  - [版本号规则](#版本号规则)
  - [发布文件名](#发布文件名)
  - [1.x 版本升级规则](#1x-版本升级规则)
  - [日常 CI 与发布流程](#日常-ci-与发布流程)
- [依赖管理](#依赖管理)
  - [版本写法与更新](#版本写法与更新)
  - [安全检查](#安全检查)
  - [修改依赖注意](#修改依赖注意)
- [常见问题](#常见问题)

## 快速开始

```bash
pnpm install
pnpm doctor
pnpm dev:desktop
```

- `pnpm doctor`：检查本机工具链；传入 `--desktop` 仅检查桌面端环境。
- `pnpm dev:desktop`：先构建后端 sidecar，再启动前端开发服务器（`127.0.0.1:1420`，被占用时自动顺延端口）与 Tauri 宿主。修改界面热更新，修改 `apps/desktop/src-tauri` 自动重编重启，修改 `src/backend` 或 `src/sidecar` 需重启命令。
- `pnpm dev:mobile`：在浏览器中启动移动端界面用于调试布局；涉及文件授权与局域网传输的原生插件功能需在真机或模拟器中调试。

提交代码前请运行 `pnpm check`。

## 环境要求

### 工具版本

| 工具 | 要求 |
| --- | --- |
| Node.js | 22.13+，建议用仍在官方维护期内的主版本里最新的安全补丁版本（`pnpm security:node` 不达标时提示）；需支持 TypeScript 类型剥离，部分 Linux 发行版打包的 Node 去掉了这项功能，改用 nodejs.org 的官方构建；桌面端开发版使用 `PATH` 中的 `node` 运行 sidecar |
| pnpm | 10.34.8（与 [package.json](../package.json) 的 `packageManager` 一致） |
| Rust | stable，含 clippy 与 rustfmt。Windows 使用 `x86_64-pc-windows-msvc`，另需 VS 生成工具的“使用 C++ 的桌面开发”工作负载与 Windows SDK；Linux 使用 `x86_64-unknown-linux-gnu` |
| WebView2 运行时（Windows） | Windows 11 自带 |
| WebKitGTK 4.1 开发包（Linux） | 见 [Linux 环境准备](#linux-环境准备) |
| JDK | 21–24（建议 21.0.13+）；Gradle 8.14 不能在更新的 JDK 上运行 |
| Android SDK | Platform 36、Build Tools 35.0.0+、Platform Tools、Command-line Tools（latest） |
| Android Studio | 2025.2.1+（仅调试 Android 原生代码时需要） |

仅开发与运行桌面端时不需要安装 Android SDK 与 Android Studio；提交前运行 `pnpm check` 中的 Checkstyle 检查需要 JDK 21–24。Android 最低支持 Android 11（API 30），编译目标为 API 36；前端 React 版本锁定在 18（受限于 `antd-mobile` 动画依赖）。

### Linux 环境准备

以下命令适用于 Debian、Ubuntu 及其衍生发行版，安装 Tauri 的构建依赖和 Rust：

```bash
sudo apt update
sudo apt install build-essential pkg-config curl wget file libssl-dev libxdo-dev librsvg2-dev libwebkit2gtk-4.1-dev
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --component clippy,rustfmt
```

- Node.js 用 nodejs.org 的官方构建或 nvm、fnm 等版本管理器安装，`pnpm doctor --desktop` 的 “Node.js TypeScript stripping” 一项通过即可。
- rustup 把工具装在 `~/.cargo/bin`，新开终端或执行 `. "$HOME/.cargo/env"` 后生效。
- `pnpm lint` 的 Checkstyle 需要 JDK 21–24，软件源里有 `openjdk-21-jdk` 时直接安装，没有时另装 Eclipse Temurin 21；脚本不读系统默认的 `java`，要在 `dev.local.json` 的 `javaHome` 或 `JAVA_HOME` 里指定 JDK 21 的路径（Debian 系的 apt 包安装在 `/usr/lib/jvm/java-21-openjdk-amd64`）。
- 从 Windows 复制过来的仓库要删掉 `node_modules` 后重新 `pnpm install`，其中带有平台相关的二进制。
- 打包另需 `patchelf`（`sudo apt install patchelf`），见 [Linux 打包说明](#linux)。

### 本机工具路径

若 JDK、Android SDK 等工具不在系统默认路径，将根目录 [dev.local.example.json](../dev.local.example.json) 复制为 `dev.local.json`（已被 Git 忽略）并填入绝对路径：

```json
{
  "androidSdk": "C:/path/to/Android/Sdk",
  "javaHome": "C:/path/to/jdk-21",
  "androidStudio": "C:/path/to/Android Studio/bin/studio64.exe",
  "gradleProxy": "",
  "androidSerial": "",
  "fridaServer": ""
}
```

- 留空或未创建时，脚本会回退读取 `JAVA_HOME`、`ANDROID_HOME` / `ANDROID_SDK_ROOT`、`CAPACITOR_ANDROID_STUDIO_PATH` 与 Windows 常见安装路径；在 Android Studio 中打开工程时，请将 Gradle JDK 配置为同一套 JDK 21。
- 需要代理时在 `gradleProxy` 填入不带账号密码的 HTTP 代理地址，仅作用于 Gradle。
- `androidSerial` 与 `fridaServer` 也可通过环境变量 `SAVEDATA_SYNC_ADB_SERIAL`、`SAVEDATA_SYNC_FRIDA_SERVER` 设置。

## 常用命令

以下命令均在仓库根目录执行：

| 分类 | 命令 | 作用 |
| --- | --- | --- |
| 开发与打包 | `pnpm doctor` | 检查本机工具链（支持 `--desktop`、`--json`） |
| 开发与打包 | `pnpm dev:desktop` | 启动桌面端开发模式 |
| 开发与打包 | `pnpm dev:mobile` | 在浏览器中启动移动端前端开发服务器 |
| 开发与打包 | `pnpm dev:android` | 启动移动端前端开发服务器并做 USB 端口转发，供真机加载 |
| 开发与打包 | `pnpm desktop:package` | 打包桌面端：Windows x64 上产出安装包与免安装 zip，Linux x64 上产出 AppImage 与 deb |
| 检查与测试 | `pnpm check` | 提交前全量检查：typecheck、ESLint、Checkstyle、Clippy、构建、编码与格式化检查 |
| 检查与测试 | `pnpm format` | 自动修复 ESLint 并运行 Prettier 与 `rustfmt` |
| 检查与测试 | `pnpm lint` / `pnpm typecheck` / `pnpm build` | 单独运行对应检查或构建 |
| 检查与测试 | `pnpm test` | 运行共享包与桌面端 sidecar 测试（无需 Android 工具） |
| 检查与测试 | `pnpm test:all` | 运行 `pnpm test` 与 `pnpm android:test` |
| 检查与测试 | `pnpm release:loopback` | 双端回环测试：启动两个桌面端后端经 `127.0.0.1` 双向传输并验证备份与恢复（发布工作流会自动运行） |
| Android | `pnpm android:sync` | 构建移动端前端资源并同步至 Android 工程 |
| Android | `pnpm android:build` | 构建 debug APK（加 `--release` 构建签名后的 release APK） |
| Android | `pnpm android:build:dev-server` | 构建加载桌面端 Vite 开发服务器的 debug APK |
| Android | `pnpm android:install` | 覆盖安装 debug APK 到已连接设备（保留应用数据） |
| Android | `pnpm android:unit` | 运行 Java 单元测试与 Windows/Java 归档互通检查（复用 Gradle 守护进程） |
| Android | `pnpm android:test` | 在 `android:unit` 基础上运行 Android lint 并构建调试与测试 APK |
| Android | `pnpm android:open` | 使用 Android Studio 打开 Android 工程 |
| 安全审计 | `pnpm security:node` | 审计 npm 依赖与 Node/pnpm 安全基线 |
| 安全审计 | `pnpm security:android` | 解析 Android 依赖并查询 OSV 安全公告 |

`pnpm check` 不含自动化测试；测试规范与验收标准见[项目记忆](../.project-memory/INDEX.md)。

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| `apps/shared` | 两端共用的通信协议、数据模型、校验规则与纯展示组件 |
| `apps/desktop` | 桌面端（Windows、Linux）：Tauri 宿主（`src-tauri`）、Node 后端 sidecar 与 React 界面 |
| `apps/mobile` | 移动端：React 前端页面及 `android/` 下的 Capacitor 原生工程 |
| `scripts` | 检查、构建、版本号计算与安全审计脚本；`scripts/device` 为真机调试工具 |
| `.project-memory` | 需求、架构、接口约定、决策、计划与测试记录 |

## 桌面端打包

`pnpm desktop:package` 根据当前系统在 `apps/desktop/release/` 生成对应平台的发布包（均无数字签名）。

### 后端 sidecar

- Windows 与 Linux 的后端 sidecar 均由 `@yao-pkg/pkg` 编成独立可执行文件（Windows 为 `savedata-sync-backend.exe`，Linux 为 `savedata-sync-backend`），内嵌预编译 Node 22（仅含英文区域数据），与本机 `node` 版本无关；升级 `@yao-pkg/pkg` 后可更新内嵌 Node。首次打包时 pkg-fetch 会从 GitHub 下载基础二进制。
- 运行 [build-sidecar-exe.mjs](../apps/desktop/scripts/build-sidecar-exe.mjs) 可单独生成 sidecar 可执行文件到 `apps/desktop/src-tauri/binaries/`（已被 Git 忽略）。

### Windows

| 产物 | 说明 |
| --- | --- |
| `SavedataSync-<版本>-windows-amd64-setup.exe` | NSIS 安装包，支持当前用户（`%LOCALAPPDATA%\Savedata Sync`）或所有用户（`%ProgramFiles%\Savedata Sync`）；缺少 WebView2 时自动下载安装 |
| `SavedataSync-<版本>-windows-amd64-portable.zip` | 免安装版，含 `SavedataSync.exe` 与 `savedata-sync-backend.exe` |

首次打包时 Tauri 会从 GitHub 下载 NSIS 工具。

### Linux

| 产物 | 说明 |
| --- | --- |
| `SavedataSync-<版本>-linux-amd64.AppImage` | 内含 WebKitGTK，可放在任意文件夹运行；同级目录有 `portable_data` 时数据保存在其中 |
| `SavedataSync-<版本>-linux-amd64.deb` | 依赖系统的 `libwebkit2gtk-4.1-0` 和 `libgtk-3-0`，数据始终写在 XDG 目录 |

- 构建依赖见 [Linux 环境准备](#linux-环境准备)，另需 `patchelf`：sidecar 打包前要预设 RUNPATH，否则生成 AppImage 时 linuxdeploy 会改写 sidecar，pkg 附在文件末尾的代码随之损坏。打包脚本最后核对 AppImage 里的 sidecar 与构建产物是否一致，不一致则失败。
- 发布包在 Ubuntu 22.04 上构建，在更新的发行版上构建的包可能要求更高的 glibc。
- 首次打包时 Tauri 会从 GitHub 下载 linuxdeploy 和 AppImage 运行时。
- 在没有 FUSE 2 的系统上运行 AppImage 时设环境变量 `APPIMAGE_EXTRACT_AND_RUN=1`，或者安装 `libfuse2`。

## Android 构建与调试

```bash
pnpm android:build
pnpm android:open
```

debug APK 输出至 `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`。首次构建需联网下载 Gradle、AGP 与 Maven 依赖；多设备连接时可通过 `adb -s <serial>` 或 `dev.local.json` 的 `androidSerial` 指定设备。

### 用 Chrome 检查页面

仅调试构建支持远程检查：

1. 手机开启 USB 调试并连接电脑，打开应用。
2. Chrome 打开 `chrome://inspect/#devices`（Edge 为 `edge://inspect`），勾选 “Discover USB devices”。
3. 在 `io.github.galgame.savedatasync` 下点击 **inspect**（首次加载若窗口空白可改点 “inspect fallback”）。

应用重启后需在设备列表重新点击 inspect；扫码取景、系统栏与权限弹窗等原生界面使用 Android Studio Layout Inspector 查看。

### 加载电脑上的开发服务器

调试移动端界面时，可让手机端应用直接加载电脑上的 Vite 热更新页面：

```bash
pnpm android:build:dev-server
pnpm android:install
pnpm dev:android
```

`pnpm dev:android` 通过 USB 将手机 `5173` 端口转发到电脑 Vite 服务（仅监听 `127.0.0.1`）。修改 Java 代码后需重新执行前两条命令；拔插 USB 或 adb 重启后重新运行 `pnpm dev:android` 恢复转发。

切回内置页面时运行：

```bash
pnpm android:build
pnpm android:install
node scripts/device/device.mjs unreverse
```

`pnpm android:build --release` 会自动重同步配置并使用内置页面。若直接通过 Gradle 或 Android Studio 打 release 包且报 `capacitor.config.json` 含 `server.url`，先运行 `pnpm android:sync`。

## 真机调试工具

`scripts/device/` 提供面向真机的命令行调试与测试工具：

| 脚本 | 作用 |
| --- | --- |
| [device.mjs](../scripts/device/device.mjs) | 封装常用 adb 操作：安装、启停、日志、界面检查与点按、进程暂停/恢复、调试版私有数据读写、测试目录管理、CDP/开发服务器端口转发、诊断广播与 frida。不带参数运行可查看全部子命令 |
| [cdp.mjs](../scripts/device/cdp.mjs) | 经 Chrome DevTools Protocol 在应用 WebView 执行脚本并输出结果（桌面端调试版在设置 `SAVEDATA_SYNC_DEVTOOLS_PORT=<端口>` 启动后同样可用） |
| [test-data.mjs](../scripts/device/test-data.mjs) | 生成 `small`、`many`、`large` 三种规模的确定性合成存档，以及比对两个本机目录 |
| [frida/attach.py](../scripts/device/frida/attach.py) | 由 `device.mjs frida-attach` 通过 `uv` 调用的 frida 附加脚本 |

- `device.mjs` 仅执行白名单子命令，不卸载应用或清除应用数据，测试文件限定在 `/sdcard/Download/gss-sync-test`（临时目录放 `tmp/<名称>`，用完以 `fixture-rm` 清理）。
- 在 Git Bash 中运行前先执行 `export MSYS_NO_PATHCONV=1`，避免 `/sdcard`、`/data` 等参数被自动改写为 Windows 路径。

常用操作示例（读取界面文字与准备测试存档）：

```bash
node scripts/device/device.mjs start
node scripts/device/device.mjs cdp-forward
node scripts/device/cdp.mjs 9333 "return document.getElementById('root').innerText"
node scripts/device/device.mjs cdp-unforward

node scripts/device/test-data.mjs generate .reports/device/data/small --profile small
node scripts/device/device.mjs fixture-push .reports/device/data/small tmp/small
node scripts/device/device.mjs fixture-compare tmp/small .reports/device/data/small
node scripts/device/device.mjs fixture-rm tmp/small
```

### 诊断与故障注入

调试版 APK 内置诊断广播入口（发布版不含），通过 `device.mjs diag` 调用，结果同时写入 logcat（`SavedataDiag` 标签）：

- `diag status`：输出当前故障开关、传输任务、本机服务与拨号连接状态。
- `diag space <target|backup|cache> <字节|off>`：模拟指定区域剩余空间。
- `diag slow-write <target|backup|cache> <毫秒|off>`：在写入前注入延迟。
- `diag drop`：立即断开全部本机网络连接（不发关闭帧）。
- `diag reset`：关闭全部故障开关。

`target` 故障仅限用于合成测试目录。故障状态仅保存在内存中，进程退出后自动清除。

### frida

仅在已 root 设备排障时使用：从 frida Release 下载与设备架构匹配的 `frida-server`，通过 `device.mjs frida-push` 推送到手机并在 `fridaServer` 填入 `/data/local/tmp/frida-server-<版本>-android-<架构>`，安装 [uv](https://docs.astral.sh/uv/) 后即可执行 `device.mjs frida-start` 与 `frida-attach`。如需 Java 层 hook，在 `scripts/device/frida/` 运行一次 `npm ci`。

## Android 签名

覆盖安装 Android 应用必须使用同一把密钥签名。未配置时 `pnpm android:build` 使用本机默认调试密钥（仅能覆盖同一台机器打出的 debug 包）；配置固定密钥后，debug 与 release 包共用该密钥，不同机器与 CI 打出的包即可互相覆盖安装。

| 场景 | 是否需要配置密钥 | 说明 |
| --- | --- | --- |
| 本地日常开发调试 | 否 | 默认使用本机调试密钥 |
| 多台机器间覆盖安装 | 是 | 生成统一密钥并在各机器配置 |
| 构建 release 包（`--release`） | 是 | 未配置签名时无法构建 |
| Fork 后通过 GitHub Actions 发布 | 是 | 需在仓库 Secrets 中配置 |

自签名包与官方 Release 包无法互相覆盖安装，切换来源前需先卸载原应用。

### 生成密钥

使用 JDK 自带的 `keytool` 生成密钥库（PKCS12 格式下密钥密码与库密码相同）：

```bash
keytool -genkeypair -v -keystore savedata-sync-release.jks -alias savedata-sync -keyalg RSA -keysize 4096 -validity 36500
```

请将密钥文件保存在仓库外部并妥善备份文件与密码。

### 本机配置

将 [apps/mobile/android/keystore.properties.example](../apps/mobile/android/keystore.properties.example) 复制为同目录下的 `keystore.properties`（已被 Git 忽略）并填写：

| 字段 | 说明 |
| --- | --- |
| `storeFile` | 密钥文件路径（使用正斜杠，如 `D:/keys/savedata-sync-release.jks`） |
| `storePassword` | 密钥库密码 |
| `keyAlias` | 密钥别名（对应上方命令中的 `savedata-sync`） |
| `keyPassword` | 密钥密码（与 `storePassword` 相同） |

也可改用环境变量 `SAVEDATA_SYNC_STORE_FILE`、`SAVEDATA_SYNC_STORE_PASSWORD`、`SAVEDATA_SYNC_KEY_ALIAS`、`SAVEDATA_SYNC_KEY_PASSWORD`（优先级高于配置文件）。四项需同时提供，配置后执行 `pnpm android:build --release`，产物位于 `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`。

### GitHub Actions 配置

在仓库 **Settings → Secrets and variables → Actions** 中配置以下四个 Repository secret（仅发布工作流需要）：

| Secret | 说明 |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | 密钥文件 Base64 编码（PowerShell：`[Convert]::ToBase64String([IO.File]::ReadAllBytes('D:\keys\savedata-sync-release.jks')) \| Set-Clipboard`） |
| `ANDROID_STORE_PASSWORD` | 同 `storePassword` |
| `ANDROID_KEY_ALIAS` | 同 `keyAlias` |
| `ANDROID_KEY_PASSWORD` | 同 `keyPassword` |

### 密钥丢失或泄露

密钥无法找回或从 APK 中反推。若丢失或泄露，只能生成新密钥并更新本地配置与 GitHub Secrets；由于无法沿用旧密钥轮换，已安装旧版的用户必须卸载重装，发布该版本时须在 Release 说明中提示用户提前转移移动端备份。

## 兼容性与卸载

### 数据兼容性与迁移

从 `1.0.0` 起按以下规则保持数据与备份兼容（设计见 [ADR-0006](../.project-memory/decisions/ADR-0006-stable-release-compatibility.md)）：

| 数据或场景 | 处理方式 |
| --- | --- |
| 结构化数据（`identity.json`、`directories.json`、游戏库配置、`backup-settings.json`、`backup-library.json` 及 Android 对应存储） | 均带 `schemaVersion`，版本升级时按版本逐级自动迁移；修改已有格式须同步编写迁移逻辑与兼容测试 |
| 简单设置（主题、语言、端口） | 宽容读取，忽略未知字段，无效字段回退默认值 |
| 读到更新版本写入的数据（整数 `schemaVersion` 高于当前应用版本） | 两端均不改动任何数据并阻止启动（桌面端 sidecar 报致命错误退出；Android 仅显示提示页，不注册业务插件、不恢复本机服务） |
| 损坏数据或 `0.x` 旧数据（`1.0.0` 为基线，不迁移 `0.x`） | 桌面端将原文件改名留在原目录后以默认值启动；Android 端删除该项数据后以默认值启动 |
| 备份与设备 ID | `1.0.0` 起写入的备份在整个 `1.x` 内均可列出和恢复；设备 ID 仅在首次启动或数据损坏时生成，版本升级不重新生成 |

两端的 `PROTOCOL_VERSION`、`/v1/sync/capabilities.schemaVersion` 与控制消息版本必须一致，不做版本协商；版本不匹配时发现列表提示版本不同，连接与发起任务前提示更新两端（版本规则见 [1.x 版本升级规则](#1x-版本升级规则)）。

### 存储目录与卸载影响

| 平台 | 数据与配置位置 | 卸载或删除程序后 |
| --- | --- | --- |
| Windows | 配置在 `%APPDATA%\galgame-savedata-sync`，数据与备份在 `%LOCALAPPDATA%\galgame-savedata-sync`（便携模式在 `portable_data`） | 数据与备份保留 |
| Linux | 配置在 `~/.config/galgame-savedata-sync`，数据与备份在 `~/.local/share/galgame-savedata-sync`（AppImage 便携模式在 `portable_data`） | 数据与备份保留 |
| Android | 应用私有存储；备份在 `Android/data/io.github.galgame.savedatasync/files/backups/` | 一并删除配置、目录访问授权与备份 |

## 版本号与发布

### 版本号规则

版本号统一由 [scripts/app-version.mjs](../scripts/app-version.mjs) 根据 Git tag 计算，各 `package.json` 中的 `version` 固定为 `0.0.0`。在根目录运行 `node scripts/app-version.mjs` 可查看当前构建版本号。

| 构建场景 | 版本名（`versionName`） | Android `versionCode` |
| --- | --- | --- |
| 发布工作流（`RELEASE_TAG`），或当前提交打有发布 tag 且工作区干净 | `1.0.0` | `major * 1000000 + minor * 1000 + patch`（如 `1.0.0` 为 `1000000`） |
| 发布 tag 之后的开发构建 | `1.0.0+12.gcfb3753`（工作区有未提交改动时末尾加 `.d`） | 与最近的发布 tag 一致 |
| 无有效发布 tag（无 Git 环境或浅克隆未拉取 tag） | `0.0.0+unknown` | `1` |

- 发布 tag 格式必须为 `v<major>.<minor>.<patch>`（每段 0–999 且无前导零），带 `-` 的预发布 tag 不参与计算。
- 开发版与对应 tag 正式版的 `versionCode` 相同，使用同一签名时可互相覆盖安装。
- Android Gradle 构建会调用该脚本，需确保 `PATH` 中存在 `node`。
- 开发模式下版本号在启动时计算一次；Windows 与 Linux 分发包文件名及 Windows exe 文件属性仅保留数字版本号（如 `1.0.0`），界面显示完整版本号。

### 发布文件名

发布文件按 `SavedataSync-<版本>-<系统>-<架构>[-<形式>].<扩展名>` 命名，由打包脚本和发布工作流生成：

| 段 | 取值 |
| --- | --- |
| 系统 | `windows`、`linux`、`android` |
| 架构 | `amd64`、`arm64`；APK 不含原生库、各架构通用，写 `universal` |
| 形式 | 同一系统和架构有多种包时加，目前只有 Windows：`setup`（安装包）、`portable`（免安装版）；其余省略 |
| 扩展名 | `.AppImage` 保留官方大小写，其余小写 |

当前产物为 `windows-amd64-setup.exe`、`windows-amd64-portable.zip`、`linux-amd64.AppImage`、`linux-amd64.deb` 和 `android-universal.apk`。不另附校验和文件，各文件的 SHA-256 由 GitHub 在 Release 页面显示。改名时同步修改打包脚本、[发布工作流](../.github/workflows/release.yml)和 README 里的文件名。

### 1.x 版本升级规则

| 版本段 | 适用变更 | 两端互通 |
| --- | --- | --- |
| 补丁（`1.0.x`） | 仅修复缺陷；不改落盘格式、`PROTOCOL_VERSION`、能力版本或控制消息版本 | 同一次版本下的不同补丁版本可互连 |
| 次版本（`1.x.0`） | 新增功能；可改落盘格式（须带自动迁移），可升级协议或能力版本（须维护者同意） | 协议或能力版本变化时两端须同时更新，并在发布说明写明 |
| 主版本（`x.0.0`） | 存在无法自动迁移的破坏性变更（例如不再恢复上一主版本写入的备份） | 按发布说明处理 |

### 日常 CI 与发布流程

- **日常 CI**：分支推送与 PR 在 Windows 上运行 `pnpm check` 与 Android debug 构建，在 Ubuntu 22.04 上运行 `pnpm check` 与 `pnpm test`，不保留产物。
- **发布分支**：仅从 `master` 分支发布（补丁版本同样在 `master` 修复后打 tag，不单独维护发布分支）。

发版步骤：

1. 打 tag 前在本地完成 CI 不覆盖的检查：依赖安全审计（`pnpm security:node`、`pnpm security:android`），以及打包产物与升级路径等发布前验证（`pnpm check`、`pnpm test:all` 与 `pnpm release:loopback` 由发布工作流运行）。
2. 取得维护者对目标 tag 名的同意后，在 `master` 最新提交打 tag 并原子推送（单独推送 tag 会导致工作流分支校验失败）：

   ```bash
   git tag -a v<版本号> -m "<版本号> 版本名称"
   git push --atomic origin master v<版本号>
   ```

3. 推送 tag 后触发[发布工作流](../.github/workflows/release.yml)（需仓库 Actions 具备 `contents: write` 权限）：校验 tag 与 `origin/master`、运行 `pnpm check`、`pnpm test:all` 与 `pnpm release:loopback`、打包 Windows x64 安装包与免安装 zip、在 Ubuntu 22.04 上运行 `pnpm test` 与 `pnpm release:loopback` 并打包 Linux 的 AppImage 与 deb、构建并校验签名后的 Android release APK、上传 Actions artifact 并创建**草稿 GitHub Release**（标题默认取附注 tag 的首行说明，未写时回退为版本号）。
4. 在草稿 Release 页面补充已知问题、安装限制与兼容变更说明后正式发布。若工作流失败，须经维护者同意后删除 tag，修复后再重新打 tag。

## 依赖管理

### 版本写法与更新

`package.json` 里的版本写法按字段决定，`pnpm check` 会检查：

- `dependencies` 和 `peerDependencies` 会打包给用户，写精确版本；两个应用共用的运行时库（antd、`@ant-design/icons`、react、react-dom、`qrcode.react`）写 `catalog:`，版本只写在 [pnpm-workspace.yaml](../pnpm-workspace.yaml) 的 `catalog`。
- `devDependencies` 是开发工具，写 `^` 范围；`@capacitor/cli` 例外，和其他 Capacitor 包同版本、写精确版本。
- 新版本发布满 3 天才会被解析（`minimumReleaseAge`）。

实际安装的版本由 `pnpm-lock.yaml` 固定。发版前和平时每月左右更新一次：

```bash
pnpm update -r
pnpm outdated -r
pnpm check
pnpm test
pnpm security:node
pnpm security:android
```

- `pnpm update -r` 只升级写 `^` 的开发工具，不越过主版本。
- `pnpm outdated -r` 列出可升级的运行时依赖和开发工具的新主版本，逐个决定是否升级；运行时依赖升级后按[依赖表](../.project-memory/architecture/dependencies.md)复测。Rust 依赖用 `cargo update`，Android 依赖改 Gradle 文件里的版本。

### 安全检查

安全检查需手动联网执行，日常 CI 不运行：

```bash
pnpm security:node
pnpm security:android
```

- `security:node`：通过 npm registry 审计全部依赖，向 OSV 查询固定 pnpm 版本，并向 Node 官方查询发行记录和维护期，检查打包进 sidecar 的 Node（pkg-fetch 选定的版本）和本机 Node：主版本要在维护期内，且不低于这个主版本最新的安全发布，规则在 [scripts/toolchain-policy.mjs](../scripts/toolchain-policy.mjs)。打包进 sidecar 的 Node 随应用发给用户，不达标时检查失败，升级 `@yao-pkg/pkg` 或它固定的 `@yao-pkg/pkg-fetch`；本机 Node 只运行开发工具和开发版 sidecar，不达标时只提示。
- `security:android`：同步 Android 工程并解析全部 Maven 配置与 buildscript classpath（输出至 `.reports/android-dependencies.json`），向 OSV 查询已知漏洞。

最近一次审计结果与待处理公告见[当前回归状态](../.project-memory/testing/regression-notes.md)。

### 修改依赖注意

- [pnpm-workspace.yaml](../pnpm-workspace.yaml) 中的 `overrides` 用于统一同主版本 npm 包，`peerDependencyRules` 允许 `eslint-plugin-react` 7.37 搭配 ESLint 10；跨主版本共存的包暂不强行合并。
- [gradle-wrapper.properties](../apps/mobile/android/gradle/wrapper/gradle-wrapper.properties) 配置了 Gradle 分发包 SHA-256 校验；[dependency-security.json](../apps/mobile/android/dependency-security.json) 通过 `singleVersionModules` 锁定 Android 间接依赖为单一版本（`listenablefuture` 固定为 `1.0`），存在多版本冲突时 `security:android` 会报错。
- GitHub Actions 中的第三方 Action 固定到具体 commit SHA。

## 常见问题

**`pnpm doctor` 提示缺少工具或未接受协议**  
按提示安装对应工具（Android SDK 需运行 `sdkmanager --licenses` 接受许可），或在 `dev.local.json` 中手动指定路径。

**桌面端开发版没有窗口，或提示 “The background service could not start”**  
窗口在后端 sidecar 初始化完成后才打开。确认 `PATH` 中有 `node`，并查看运行 `pnpm dev:desktop` 终端中 sidecar 的报错输出。

**桌面端开发版接收内容时报网络中断，之后启动报 `path-outside-root`**  
在部分通过 MSIX 打包的 IDE 或终端中运行 `pnpm dev:desktop` 时，进程会继承文件系统重定向，导致写入 `%LOCALAPPDATA%` 的文件实际落入 `%LOCALAPPDATA%\Packages\<包名>\LocalCache\Local\`：

- 接收时的缓存目录与登记路径不一致会中止传输，并使下次启动因残留 `job-*` 目录失败。
- 改在普通终端运行；若已出现残留，删除重定向路径下 `galgame-savedata-sync\cache\transfer-archives-v1\` 中的 `job-*` 目录。
- 这类终端中修改的 `data\` 配置文件也只作用于重定向副本，普通终端启动的桌面端读取不到。

**Android SAF 读取文件后 `ctime` 发生变化**  
部分系统的 DocumentProvider 在首次授权读取后会更新文件 `ctime`，校验文件一致性时应以文件内容、大小和 `mtime` 为准，不依赖 `ctime`。
