# 开发指南

本文档面向参与本项目开发、构建与发布的开发者。应用使用说明见[根目录 README](../README.md)，架构设计、接口约定与当前状态见[项目记忆](../.project-memory/INDEX.md)。

## 目录

- [快速开始](#快速开始)
- [环境要求](#环境要求)
- [本机工具路径](#本机工具路径)
- [常用命令](#常用命令)
- [仓库结构](#仓库结构)
- [Android 构建与调试](#android-构建与调试)
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

- `pnpm doctor` 检查 Node、pnpm、JDK 和 Android SDK 是否齐全；加上 `--desktop` 参数可只检查桌面端开发环境。
- `pnpm dev:desktop` 启动桌面端开发模式，修改主进程或 preload 代码后会自动重启（仅刷新页面不会重载旧主进程，若热重启异常可手动重启开发进程）。
- `pnpm dev:mobile` 在浏览器中启动移动端前端页面，适合调试 UI；涉及文件系统访问、局域网传输等依赖 Android 原生插件的功能，需要构建到真机或模拟器中调试。

提交代码前请运行 `pnpm check`。

## 环境要求

| 工具 | 要求 |
| --- | --- |
| Node.js | 22.13+（建议 22.23.4+ 或 24.22.1+，以满足安全基线） |
| pnpm | 10.34.8（与 `package.json` 的 `packageManager` 一致） |
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
  "gradleProxy": ""
}
```

- 留空或未创建该文件时，脚本会回退读取 `JAVA_HOME`、`ANDROID_HOME` / `ANDROID_SDK_ROOT`、`CAPACITOR_ANDROID_STUDIO_PATH` 以及 Windows 常见安装路径。
- 构建脚本会自动使用上述路径和仓库自带的 Gradle Wrapper。若在 Android Studio 中打开工程，请将 Gradle JDK 也配置为同一个 JDK 21。
- 需要代理时可在 `gradleProxy` 填入不带账号密码的 HTTP 代理地址，仅作用于 Gradle。

## 常用命令

以下命令均在仓库根目录执行：

| 命令 | 作用 |
| --- | --- |
| `pnpm dev:desktop` | 启动桌面端开发模式 |
| `pnpm dev:mobile` | 在浏览器中启动移动端前端开发服务器 |
| `pnpm check` | 提交前全量检查，依次运行类型检查、ESLint 和 Checkstyle（需 JDK）、两端构建、文本编码和代码格式检查，某一步失败即停止 |
| `pnpm format` | 自动修复可修复的 ESLint 问题并格式化代码 |
| `pnpm lint` / `pnpm typecheck` / `pnpm build` | 单独运行 `pnpm check` 中的对应检查 |
| `pnpm test` | 运行脚本、共享包、桌面端和移动端前端测试（无需 Android 工具） |
| `pnpm test:all` | 运行 `pnpm test` 和 `pnpm android:test`，适合发版前或大范围改动后执行 |
| `pnpm doctor` | 检查本地工具链；支持 `--desktop`（跳过 Android 检查）和 `--json`；存在 FAIL 项时返回非零退出码 |
| `pnpm desktop:package` | 打包 Windows 安装版与免安装版；加 `portable` 参数只生成免安装版 |
| `pnpm android:sync` | 构建移动端前端资源并同步到 Android 原生工程 |
| `pnpm android:build` | 构建 debug APK；加 `--release` 构建签名后的 release APK |
| `pnpm android:test` | 运行 Java 单元测试、Android lint、测试 APK 构建及 Windows/Java 归档互通检查（无需连接真机） |
| `pnpm android:open` | 使用 Android Studio 打开原生工程 |
| `pnpm security:node` | 审计 npm 依赖及 Node、pnpm 安全基线 |
| `pnpm security:android` | 解析 Android 全部 Maven 依赖并查询 OSV 安全公告 |

`pnpm check` 不包含测试；测试规范与真机验收流程见[项目记忆](../.project-memory/INDEX.md)。

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| `apps/shared` | 两端共用的通信协议、数据模型、校验规则和 React 展示组件 |
| `apps/desktop` | Windows 桌面端：Electron 主进程、preload 和 React 界面 |
| `apps/mobile` | 移动端：React 前端页面及 `android/` 下的 Capacitor 原生工程 |
| `scripts` | 检查、构建、版本号计算与安全审计脚本 |
| `.project-memory` | 需求、架构、接口约定与测试状态记录 |

## Android 构建与调试

```bash
pnpm android:build
pnpm android:open
```

构建出的 debug APK 位于 `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`。首次构建需联网下载 Gradle、AGP 及 Maven 依赖。

在 Android Studio 中连接开启了 USB 调试的手机即可直接运行；同时连接多台设备时，命令行可通过 `adb -s <serial>` 指定设备。更换测试设备后，需在应用中重新选择并授予存档目录权限。

`pnpm android:test` 仅在本地执行，端到端同步流程需在两台真机上验收，具体方法见项目记忆中的 Android 平台层文档。

Android 原生工程由 Capacitor 管理，Manifest 中启用了明文 HTTP（用于局域网设备直连），并声明了 `dataSync` 前台服务（用于在用户发起传输时保持后台运行）。

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

- 当配置或备份存储格式变更时，桌面端读到旧配置会报错，需手动删除应用数据目录下的旧配置文件后重新添加游戏；移动端直接卸载重装。
- 当通信协议变更时，桌面端与移动端需更新至同一版本才能连接。

卸载移动端会清除游戏配置、目录访问授权以及 `Android/data` 下的备份；卸载桌面端会保留应用配置。发布包含不兼容变更的版本时，需在 Release 说明中注明处理方式。

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
3. 使用 `pnpm desktop:package portable` 打包 Windows x64 免安装版（无数字签名）。
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

**桌面端首次启动异常或无响应**
可运行 `pnpm --filter @savedata-sync/desktop exec electron --version` 检查 Electron 二进制是否正确安装。

**桌面端开发版启动报配置错误**
本地保留了旧格式的配置文件，参考[兼容性与卸载](#兼容性与卸载)删除旧配置后重试。

**Android SAF 读取文件后 `ctime` 发生变化**
部分系统的 DocumentProvider 在首次授权读取后会更新文件 `ctime`，校验文件一致性时应以文件内容、大小和 `mtime` 为准，不要依赖 `ctime`。
