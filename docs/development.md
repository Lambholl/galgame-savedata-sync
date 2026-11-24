# 开发指南

本文档面向参与本项目开发、构建与发布的开发者。应用使用说明见[根目录 README](../README.md)，架构设计、接口约定与当前状态见[项目记忆](../.project-memory/INDEX.md)。

## 目录

- [快速开始](#快速开始)
- [环境要求](#环境要求)
- [本机工具路径](#本机工具路径)
- [常用命令](#常用命令)
- [仓库结构](#仓库结构)
- [Windows 打包](#windows-打包)
- [Android 构建与调试](#android-构建与调试)
- [真机调试工具](#真机调试工具)
  - [安全边界](#安全边界)
  - [常用流程](#常用流程)
  - [frida](#frida)
- [Android 签名](#android-签名)
  - [生成密钥](#生成密钥)
  - [本机配置](#本机配置)
  - [GitHub Actions 配置](#github-actions-配置)
  - [密钥丢失或泄露](#密钥丢失或泄露)
- [兼容性与卸载](#兼容性与卸载)
- [版本号与发布](#版本号与发布)
  - [版本号规则](#版本号规则)
  - [发布流程](#发布流程)
- [依赖安全检查](#依赖安全检查)
- [常见问题](#常见问题)

## 快速开始

```bash
pnpm install
pnpm doctor
pnpm dev:desktop
```

- `pnpm doctor` 检查 Node、pnpm、Rust、MSVC 生成工具、WebView2 运行时、JDK 和 Android SDK 是否齐全；加上 `--desktop` 参数可只检查桌面端开发环境。
- `pnpm dev:desktop` 启动桌面端开发模式：先构建后端 sidecar，再启动界面开发服务器（`127.0.0.1:1420`）和 Tauri 宿主。界面代码修改后热更新；`apps/desktop/src-tauri` 的 Rust 代码修改后宿主自动重新编译并重启；后端（`src/backend`、`src/sidecar`）修改后需停止并重新运行该命令。
- `pnpm dev:mobile` 在浏览器中启动移动端前端页面，适合调试 UI；涉及文件系统访问、局域网传输等依赖 Android 原生插件的功能，需要构建到真机或模拟器中调试。

提交代码前请运行 `pnpm check`。

## 环境要求

| 工具 | 要求 |
| --- | --- |
| Node.js | 22.13+（建议 22.23.4+ 或 24.22.1+，以满足安全基线）；桌面端开发版用 `PATH` 中的 `node` 运行后端 |
| pnpm | 10.34.8（与 `package.json` 的 `packageManager` 一致） |
| Rust | stable，Windows 使用 MSVC 工具链（`x86_64-pc-windows-msvc`），另需 Visual Studio 生成工具的“使用 C++ 的桌面开发”工作负载和 Windows SDK；`cargo` 需在 `PATH` 中 |
| WebView2 运行时 | Windows 11 自带；桌面端界面运行在其中 |
| JDK | 21（建议 21.0.13+） |
| Android SDK | Platform 36、Build Tools 35.0.0+、Platform Tools；建议同时安装 Command-line Tools（latest） |
| Android Studio | 2025.2.1+（仅调试 Android 原生代码时需要） |

仅开发桌面端时不需要安装 JDK、Android SDK 和 Android Studio。

Android 端最低支持 Android 11（API 30），编译目标为 API 36。前端 React 版本锁定在 18（受限于 `antd-mobile` 动画依赖的兼容范围）。

## 本机工具路径

如果 JDK、Android SDK 等工具不在系统默认位置，无需修改全局环境变量，将根目录的 `dev.local.example.json` 复制为 `dev.local.json`（已被 Git 忽略）并填入绝对路径即可：

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

- 留空或未创建该文件时，脚本会回退读取 `JAVA_HOME`、`ANDROID_HOME` / `ANDROID_SDK_ROOT`、`CAPACITOR_ANDROID_STUDIO_PATH` 以及 Windows 常见安装路径。
- 构建脚本会自动使用上述路径和仓库自带的 Gradle Wrapper。若在 Android Studio 中打开工程，请将 Gradle JDK 也配置为同一个 JDK 21。
- 需要代理时可在 `gradleProxy` 填入不带账号密码的 HTTP 代理地址，仅作用于 Gradle。
- `androidSerial` 和 `fridaServer` 供[真机调试工具](#真机调试工具)使用，也可以用环境变量 `SAVEDATA_SYNC_ADB_SERIAL`、`SAVEDATA_SYNC_FRIDA_SERVER` 设置。

## 常用命令

以下命令均在仓库根目录执行：

| 命令 | 作用 |
| --- | --- |
| `pnpm dev:desktop` | 启动桌面端开发模式 |
| `pnpm dev:mobile` | 在浏览器中启动移动端前端开发服务器 |
| `pnpm desktop:package` | 打包 Windows x64 安装包和免安装 zip，见 [Windows 打包](#windows-打包) |
| `pnpm check` | 提交前全量检查，依次运行类型检查、ESLint、Checkstyle（需 JDK）和 Clippy、两端构建、文本编码和代码格式检查（Prettier、rustfmt），某一步失败即停止 |
| `pnpm format` | 自动修复可修复的 ESLint 问题，并用 Prettier 和 rustfmt 格式化代码 |
| `pnpm lint` / `pnpm typecheck` / `pnpm build` | 单独运行 `pnpm check` 中的对应检查 |
| `pnpm test` | 运行脚本、共享包、桌面端（含 Tauri 宿主的 Rust 测试）和移动端前端测试（无需 Android 工具） |
| `pnpm test:all` | 运行 `pnpm test` 和 `pnpm android:test`，适合发版前或大范围改动后执行 |
| `pnpm doctor` | 检查本地工具链；支持 `--desktop`（跳过 Android 检查）和 `--json`；存在 FAIL 项时返回非零退出码 |
| `pnpm android:sync` | 构建移动端前端资源并同步到 Android 原生工程 |
| `pnpm android:build` | 构建 debug APK；加 `--release` 构建签名后的 release APK |
| `pnpm android:unit` | 运行 Java 单元测试和 Windows/Java 归档互通检查（无需连接真机），复用 Gradle 后台进程，适合修改 Java 代码后反复运行 |
| `pnpm android:test` | 在 `pnpm android:unit` 的基础上另跑 Android lint、构建调试 APK 和测试 APK，每次启动新的 Gradle 进程，适合发版前执行 |
| `pnpm android:open` | 使用 Android Studio 打开原生工程 |
| `pnpm security:node` | 审计 npm 依赖及 Node、pnpm 安全基线 |
| `pnpm security:android` | 解析 Android 全部 Maven 依赖并查询 OSV 安全公告 |

`pnpm check` 不包含测试；测试规范与真机验收流程见[项目记忆](../.project-memory/INDEX.md)。

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| `apps/shared` | 两端共用的通信协议、数据模型、校验规则和 React 展示组件 |
| `apps/desktop` | Windows 桌面端：Tauri 宿主（`src-tauri`）、Node 后端 sidecar 和 React 界面 |
| `apps/mobile` | 移动端：React 前端页面及 `android/` 下的 Capacitor 原生工程 |
| `scripts` | 检查、构建、版本号计算与安全审计脚本；`scripts/device` 是真机调试工具 |
| `.project-memory` | 需求、架构、接口约定与测试状态记录 |

## Windows 打包

`pnpm desktop:package` 在 Windows x64 上构建发布版，产物输出到 `apps/desktop/release/`，均无数字签名：

| 产物 | 说明 |
| --- | --- |
| `SavedataSync-<版本>-Setup-x64.exe` | NSIS 安装包，安装时选择只为当前用户安装（`%LOCALAPPDATA%\Savedata Sync`）或为所有用户安装（`%ProgramFiles%\Savedata Sync`，需要管理员权限）；系统缺少 WebView2 运行时时由安装包下载安装 |
| `SavedataSync-<版本>-Portable-x64.zip` | 免安装版，内含主程序 `SavedataSync.exe` 和后端 `savedata-sync-backend.exe`，不带 `portable_data` 文件夹 |

- 后端 sidecar 用 `@yao-pkg/pkg` 编成 `savedata-sync-backend.exe`，内嵌 pkg-fetch 预编译的 Node 22（只带英文区域数据），版本由 `@yao-pkg/pkg` 的版本决定，和执行打包命令的 `node` 无关。`@yao-pkg/pkg` 在 `apps/desktop/package.json` 里写的是 `^6.x` 范围版本，运行 `pnpm --filter @savedata-sync/desktop update @yao-pkg/pkg` 升级到同主版本的最新版，内嵌 Node 随之更新。首次打包时 pkg-fetch 从 GitHub 下载基础二进制并缓存。
- 首次打包时 Tauri 从 GitHub 下载 NSIS 工具。
- `apps/desktop/scripts/build-sidecar-exe.mjs` 可单独生成 sidecar 可执行文件，输出到 `apps/desktop/src-tauri/binaries/`（已被 Git 忽略）。

## Android 构建与调试

```bash
pnpm android:build
pnpm android:open
```

构建出的 debug APK 位于 `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`。首次构建需联网下载 Gradle、AGP 及 Maven 依赖。

在 Android Studio 中连接开启了 USB 调试的手机即可直接运行；同时连接多台设备时，命令行可通过 `adb -s <serial>` 指定设备。更换测试设备后，需在应用中重新选择并授予存档目录权限。

`pnpm android:unit` 和 `pnpm android:test` 仅在本地执行，端到端同步流程需在两台真机上验收，具体方法见项目记忆中的 Android 平台层文档。

Android 原生工程由 Capacitor 管理，Manifest 中启用了明文 HTTP（用于局域网设备直连），并声明了 `dataSync` 前台服务（用于在用户发起传输时保持后台运行）。

## 真机调试工具

`scripts/device/` 下的脚本用来在真机上安装、操作和检查应用，输出都是文本，适合在命令行或由 Agent 驱动测试：

| 脚本 | 作用 |
| --- | --- |
| `device.mjs` | 调用 adb 的唯一入口：安装、启停、日志、通知、界面文字、点按、经 `run-as` 暂停和恢复进程、读写应用私有数据、测试目录、备份查看、CDP 转发、frida。不带参数时列出全部子命令 |
| `cdp.mjs` | 经 Chrome DevTools Protocol 在应用页面里执行 JavaScript 并打印结果，读界面文字和操作界面都用它 |
| `test-data.mjs` | 生成合成测试数据（`small`、`many`、`large` 三种规模，同一个种子生成的内容相同），输出目录清单，比对两个本机目录 |
| `frida/attach.py` | 由 `device.mjs frida-attach` 经 uv 运行，见 [frida](#frida) |

只连一台设备时自动选中它；连了多台时在 `dev.local.json` 的 `androidSerial` 指定序列号。adb 优先用 Android SDK 里 platform-tools 的版本。

电脑端也能用 `cdp.mjs`：调试构建在环境变量 `SAVEDATA_SYNC_DEVTOOLS_PORT=<端口>` 下启动，WebView2 就在这个端口开放 CDP，发布构建没有这个入口。

### 安全边界

`device.mjs` 只执行列出的子命令，没有任意 shell 透传：

- 发给 adb 的参数逐词检查，出现 `rm`、`mv`、`reboot`、`kill`、`setprop`、`uninstall`、`clear`、`kill-server`、`tcpip` 等命令就拒绝执行。`su` 只用于启动和查找配置的 frida-server，`kill` 只用于 `pause`、`resume` 给本应用主进程发 SIGSTOP 和 SIGCONT，`rm` 只用于 `fixture-rm` 删除临时区。`guard-check <文本...>` 只做这项检查，不连接设备。
- 不卸载应用、不清除应用数据，以免丢失用户授权的目录；不操作系统目录选择器。
- 测试文件只写 `/sdcard/Download/gss-sync-test` 下的测试目录。临时用的目录命名为 `tmp/<名称>`，测试完用 `fixture-rm tmp/<名称>` 或 `fixture-rm tmp` 删除；其他测试目录可能已授权给应用，删掉后授权跟着失效，所以只能在手机上手动删除。
- 应用私有数据（只限调试版）只能读写 `shared_prefs/<名称>.xml`、`files/<名称>` 和 `cache/<名称>`。`private-push` 只在应用停止时写入，写入前把手机上的原内容存到 `.reports/device/private-before/<时间>/`，写入后核对哈希。
- frida 脚本源码出现 `rm`、`kill`、`su`、`setprop`、`Runtime.exec`、`ProcessBuilder` 等就拒绝附加。

### 常用流程

读应用界面用 CDP，不截图：

```bash
node scripts/device/device.mjs start
node scripts/device/device.mjs cdp-forward
node scripts/device/cdp.mjs 9333 "return document.getElementById('root').innerText"
node scripts/device/device.mjs cdp-unforward
```

应用重启后进程号会变，要重新 `cdp-forward`。系统界面（通知、权限弹窗、桌面）用 `ui-text` 读文字和坐标，再用 `tap` 点按。有的手机上 uiautomator 一直等不到界面空闲（报 `could not get idle state`），`ui-text` 用不了，这时只能截图。

准备一组测试存档并核对传输结果：

```bash
node scripts/device/test-data.mjs generate .reports/device/data/small --profile small
node scripts/device/device.mjs fixture-push .reports/device/data/small tmp/small
node scripts/device/device.mjs fixture-compare tmp/small .reports/device/data/small
node scripts/device/device.mjs fixture-rm tmp/small
```

`fixture-compare` 比对文件内容和全部子目录（包括空目录），一致时输出“一致”，有差异时逐行列出并以退出码 1 结束。两个本机目录用 `test-data.mjs compare` 比对，输出格式相同。

在 Git Bash 里运行时先 `export MSYS_NO_PATHCONV=1`，否则 Git Bash 会把参数和环境变量里的 `/sdcard`、`/data` 改写成 Windows 路径。

### frida

frida 用来在运行中的应用里挂 hook 查问题，需要已 root 的手机，是可选工具：

1. 从 frida 的 GitHub Release 下载和手机架构对应的 `frida-server-<版本>-android-<架构>`，解压后用 `device.mjs frida-push <文件>` 放到手机上，并在 `fridaServer` 写 `/data/local/tmp/frida-server-<版本>-android-<架构>`。
2. 安装 [uv](https://docs.astral.sh/uv/)。`frida-attach` 用 `uv run --with frida==<版本>` 运行 `frida/attach.py`，版本号取自 `fridaServer` 的文件名，电脑端的 frida 和手机上的 frida-server 因此总是同版本；第一次运行或换版本时 uv 会下载 frida（约 60 MB）。
3. 要用 Java 层 hook 时，在 `scripts/device/frida/` 运行一次 `npm ci` 安装锁定版本的 `frida-java-bridge`，脚本开头写 `import Java from 'frida-java-bridge'`；除此之外脚本不能 import 其他模块。

```bash
node scripts/device/device.mjs frida-start
node scripts/device/device.mjs frida-attach my-hook.js 30
```

frida-server 启动后一直运行，工具没有结束它的子命令，用完在手机上结束或重启手机。

## Android 签名

Android 系统要求覆盖安装的应用必须使用同一把密钥签名。未配置签名时，`pnpm android:build` 使用本机默认调试密钥（仅能覆盖同一台机器打出的 debug 包）；配置固定密钥后，debug 包和 release 包都会使用该密钥，不同机器与 CI 打出的包即可互相覆盖安装。

| 场景 | 是否需要配置密钥 | 说明 |
| --- | --- | --- |
| 本地日常开发调试 | 否 | 默认使用本机调试密钥 |
| 多台机器间覆盖安装 | 是 | 生成统一密钥并在各机器配置 |
| 构建 release 包（`--release`） | 是 | 未配置签名时无法构建 |
| Fork 后通过 GitHub Actions 发布 | 是 | 需在仓库 Secrets 中配置，否则发布工作流会失败 |

自签名安装包与官方 Release 安装包无法互相覆盖安装，切换版本源时需先卸载原应用（卸载影响见[兼容性与卸载](#兼容性与卸载)）。

### 生成密钥

使用 JDK 自带的 `keytool` 生成密钥库（PKCS12 格式下密钥密码与库密码相同）：

```bash
keytool -genkeypair -v -keystore savedata-sync-release.jks -alias savedata-sync -keyalg RSA -keysize 4096 -validity 36500
```

请将生成的密钥文件保存在仓库外部，并妥善备份密钥文件和密码。

### 本机配置

将 `apps/mobile/android/keystore.properties.example` 复制为同目录下的 `keystore.properties`（已被 Git 忽略）并填写：

| 字段 | 说明 |
| --- | --- |
| `storeFile` | 密钥文件路径（使用正斜杠，如 `D:/keys/savedata-sync-release.jks`） |
| `storePassword` | 密钥库密码 |
| `keyAlias` | 密钥别名（对应上面命令中的 `savedata-sync`） |
| `keyPassword` | 密钥密码（与 `storePassword` 相同） |

也可以改用环境变量 `SAVEDATA_SYNC_STORE_FILE`、`SAVEDATA_SYNC_STORE_PASSWORD`、`SAVEDATA_SYNC_KEY_ALIAS`、`SAVEDATA_SYNC_KEY_PASSWORD`（优先级高于配置文件）。无论哪种方式，四项均需完整提供。

配置完成后，执行 `pnpm android:build --release`，产物位于 `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`。

### GitHub Actions 配置

在仓库的 **Settings → Secrets and variables → Actions** 中添加以下四个 Repository secret（仅发布工作流需要，日常 PR 检查无需配置）：

| Secret | 说明 |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | 密钥文件的 Base64 编码（PowerShell 获取方式：`[Convert]::ToBase64String([IO.File]::ReadAllBytes('D:\keys\savedata-sync-release.jks')) \| Set-Clipboard`） |
| `ANDROID_STORE_PASSWORD` | 同 `storePassword` |
| `ANDROID_KEY_ALIAS` | 同 `keyAlias` |
| `ANDROID_KEY_PASSWORD` | 同 `keyPassword` |

### 密钥丢失或泄露

密钥无法找回或从 APK 中反推。若密钥丢失或泄露，只能生成新密钥并更新本地配置与 GitHub Secrets；由于无法沿用旧密钥签名做密钥轮换，已安装旧版的用户必须先卸载再安装新版。发布此类版本时，请在 Release 说明中明确提示用户卸载重装，并提前转移移动端的备份文件。

## 兼容性与卸载

应用当前处于测试阶段，不保留旧版本的数据迁移与兼容代码：

- 当配置或备份存储格式变更时，桌面端读到旧配置会报错，需手动删除 `%LOCALAPPDATA%\galgame-savedata-sync\data` 下的旧文件后重新添加游戏；移动端直接卸载重装。
- 当通信协议变更时，桌面端与移动端需更新至同一版本才能连接。

卸载移动端会清除游戏配置、目录访问授权以及 `Android/data` 下的备份；桌面端卸载或删除程序文件后，`%APPDATA%` 和 `%LOCALAPPDATA%` 下 `galgame-savedata-sync` 文件夹里的配置和备份仍会保留（免安装版使用 `portable_data` 文件夹时，数据都在该文件夹中）。发布包含不兼容变更的版本时，需在 Release 说明中注明处理方式。

## 版本号与发布

### 版本号规则

版本号统一由 `scripts/app-version.mjs` 根据 Git tag 计算，各 `package.json` 中的 `version` 固定为 `0.0.0`。可在根目录执行 `node scripts/app-version.mjs` 查看当前构建版本号。

| 构建场景 | 版本名（versionName） | Android `versionCode` |
| --- | --- | --- |
| 发布工作流（`RELEASE_TAG`），或当前提交正好打有发布 tag 且工作区干净 | `0.3.0` | `major * 1000000 + minor * 1000 + patch`（如 0.3.0 为 3000） |
| 发布 tag 之后的开发构建 | `0.3.0+12.gcfb3753`（工作区有未提交改动时末尾加 `.d`） | 与最近的发布 tag 一致 |
| 无有效发布 tag（无 Git 环境或浅克隆未拉取 tag） | `0.0.0+unknown` | 1 |

- 发布 tag 格式必须为 `v<major>.<minor>.<patch>`（每段 0–999 且无前导零），带 `-` 的预发布 tag 不参与计算。
- 开发版与对应 tag 正式版的 `versionCode` 相同，使用同一签名时可互相覆盖安装。
- Android Gradle 构建时会调用该版本脚本，需确保 `PATH` 中存在 `node`。
- 开发模式下版本号仅在启动时计算一次；Windows 分发包文件名和 exe 文件属性中只保留数字版本号（如 `0.3.0`），界面上显示完整版本号。

### 发布流程

仅从 `master` 分支发布。在 `master` 最新提交上打 tag 并同步推送：

```bash
git tag -a v0.3.0 -m "0.3.0"
git push --atomic origin master v0.3.0
```

若单独推送 tag 而未先推送 `master`，工作流的分支校验会失败；补丁版本同样直接在 `master` 上修复后打 tag，不单独维护发布分支。

推送 tag 后会触发[发布工作流](../.github/workflows/release.yml)（需确保仓库 Actions 具备 `contents: write` 权限）：

1. 校验 tag 格式及其指向的提交是否在 `origin/master` 上。
2. 运行 `pnpm check` 和 `pnpm test:all`。
3. 使用 `pnpm desktop:package` 打包 Windows x64 安装包和免安装 zip。
4. 使用 Secrets 中的签名配置构建 Android release APK，校验签名并生成 `SHA256SUMS.txt`。
5. 将产物上传为保留 7 天的 Actions artifact，并创建草稿 GitHub Release。

发布前请在草稿 Release 页面补充已知问题、安装限制及不兼容改动说明。日常分支 push 和 PR 仅运行 `pnpm check` 和 Android debug 构建（直接使用 `pnpm check` 构建的移动端网页资源），不保留构建产物。

## 依赖安全检查

安全检查脚本需手动运行并联网查询官方审计接口或 OSV，日常 CI 不执行：

```bash
pnpm security:node
pnpm security:android
```

- `security:node`：通过 npm registry 审计全部依赖，向 OSV 查询固定的 pnpm 版本，并对照 `scripts/toolchain-policy.mjs` 检查 Node 安全基线。
- `security:android`：同步 Android 工程后解析全部可解析的 Maven 配置与 buildscript classpath（输出至 `.reports/android-dependencies.json`），并向 OSV 查询这些依赖与 Gradle Core 的已知漏洞。

修改依赖时需遵循以下约定：

- `pnpm-workspace.yaml` 中的 `overrides` 用于统一同一主版本的 npm 包；跨主版本共存的包（如 `glob` 7 和 13）暂不强行合并，等待上游升级。
- `pnpm-workspace.yaml` 中的 `peerDependencyRules` 允许 `eslint-plugin-react` 7.37 搭配 ESLint 10（项目实际使用的规则在 ESLint 10 下可正常运行）。
- `gradle-wrapper.properties` 中已配置 Gradle 分发包的官方 SHA-256 校验。
- `apps/mobile/android/dependency-security.json` 用于统一锁定 Android 间接依赖版本。`singleVersionModules` 要求同一 Maven 模块在全项目中仅解析为一个版本（通常取最高版）；`listenablefuture` 固定为 `1.0`（`9999.0-empty` 为空包，且 APK 不引入 Guava）。`security:android` 检测到多版本冲突时会报错。
- GitHub Actions 中的第三方 Action 固定到具体 commit SHA，并使用 JDK 21 及 runner 预装 SDK。

最近一次审计结果与待处理公告记录在项目记忆的回归记录中。

## 常见问题

**`pnpm doctor` 提示缺少工具或未接受协议**
根据提示安装对应工具（Android SDK 需通过 `sdkmanager --licenses` 接受许可），也可在 `dev.local.json` 中手动指定本地路径。

**桌面端开发版没有窗口，或提示 “The background service could not start”**
窗口在后端 sidecar 初始化完成后才打开。确认 `PATH` 中有 `node`，并查看运行 `pnpm dev:desktop` 的终端里 sidecar 输出的错误。

**桌面端开发版启动报配置错误**
本地保留了旧格式的配置文件，参考[兼容性与卸载](#兼容性与卸载)删除旧配置后重试。

**Android SAF 读取文件后 `ctime` 发生变化**
部分系统的 DocumentProvider 在首次授权读取后会更新文件 `ctime`，校验文件一致性时应以文件内容、大小和 `mtime` 为准，不要依赖 `ctime`。
