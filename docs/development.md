# 开发指南

给要在本仓库里改代码、构建或发布的开发者。应用怎么用见[根目录 README](../README.md)；模块设计、接口和当前状态见[项目记忆](../.project-memory/INDEX.md)。

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
  - [版本号](#版本号)
  - [发布步骤](#发布步骤)
- [依赖安全检查](#依赖安全检查)
- [常见问题](#常见问题)

## 快速开始

```bash
pnpm install
pnpm doctor
pnpm dev:desktop
```

`pnpm doctor` 检查 Node、pnpm、JDK 和 Android SDK 是否齐全，只读取环境，缺少的工具要自己安装。只开发电脑端时用 `pnpm doctor --desktop`，不检查 Android 工具。

`pnpm dev:desktop` 启动电脑端，主进程和 preload 改动后自动重启。改动前已经开着的开发进程要退出重开一次，只刷新页面不会替换旧主进程。`pnpm dev:mobile` 在浏览器里打开移动端网页，适合调界面；目录、传输等原生功能只在 Android 应用里可用。

提交前运行 `pnpm check`。

## 环境要求

| 工具 | 要求 |
| --- | --- |
| Node.js | 22.13 起可以运行；安全基线是 22.23.4+（22.x）或 24.22.1+（24.x） |
| pnpm | 10.34.8，与 `package.json` 的 `packageManager` 一致 |
| JDK | 21，需要包含 `javac`；建议 21.0.13 以上 |
| Android SDK | Platform 36、Build Tools 35.0.0 或更新、Platform Tools；建议同时装 Command-line Tools（latest） |
| Android Studio | 2025.2.1 或更新，只在调试 Android 原生代码时需要 |

只开发电脑端时不需要 JDK、Android SDK 和 Android Studio。

Android 应用最低支持 Android 11（API 30），用 API 36 编译。依赖版本固定在各 `package.json` 和 `pnpm-lock.yaml`。React 停在 18，因为 antd-mobile 的间接动画依赖还要求 React 18。

## 本机工具路径

项目不改全局 PATH、JAVA_HOME 或 SDK 环境变量。工具不在默认位置时，把 `dev.local.example.json` 复制为 `dev.local.json`（已被 Git 忽略），填绝对路径：

```json
{
  "androidSdk": "C:/path/to/Android/Sdk",
  "javaHome": "C:/path/to/jdk-21",
  "androidStudio": "C:/path/to/Android Studio/bin/studio64.exe",
  "gradleProxy": ""
}
```

- 空字符串表示不指定。没有这个文件或某项为空时，依次读 `JAVA_HOME`、`ANDROID_HOME` / `ANDROID_SDK_ROOT` 和 `CAPACITOR_ANDROID_STUDIO_PATH`；SDK 还会找 Windows 上的常见安装位置。JSON 写错时命令直接报错。
- Android 构建命令只给自己的子进程设置 JDK 和 SDK 变量，并使用仓库里的 Gradle Wrapper。Android Studio 的 Gradle JDK 也选同一个 JDK 21。
- 需要代理时在 `gradleProxy` 填不带账号密码的 HTTP 代理地址。代理只传给 Gradle，系统代理不受影响。

## 常用命令

都在仓库根目录运行。

| 命令 | 作用 |
| --- | --- |
| `pnpm dev:desktop` | 启动电脑端开发版 |
| `pnpm dev:mobile` | 在浏览器里启动移动端网页 |
| `pnpm check` | 提交前检查：文本编码、格式、ESLint、Checkstyle、类型检查和两端构建。Checkstyle 需要 JDK |
| `pnpm format` | 自动修复 ESLint 能修的问题并格式化代码 |
| `pnpm lint` / `pnpm typecheck` / `pnpm build` | `pnpm check` 里的单项 |
| `pnpm test` | 脚本、共享包、电脑端和移动端网页的自动化测试，不需要 Android 工具 |
| `pnpm test:all` | `pnpm test` 加 `pnpm android:test`，发布前或大范围改动后运行 |
| `pnpm doctor` | 检查开发工具；`--desktop` 跳过 Android 工具，`--json` 输出结构化结果。有 FAIL 时退出码为 1，WARN 不算失败 |
| `pnpm desktop:package` | 生成 Windows 安装版和免安装版；`pnpm desktop:package portable` 只生成免安装版 |
| `pnpm android:sync` | 构建移动端网页并同步到 Android 工程 |
| `pnpm android:build` | 构建 debug APK；`pnpm android:build --release` 构建签名的 release APK |
| `pnpm android:test` | Java 单元测试、Android lint、调试和仪器测试 APK 构建，以及 Windows/Java 归档互通检查；不连接设备 |
| `pnpm android:open` | 用 Android Studio 打开原生工程 |
| `pnpm security:node` | npm 依赖审计，以及 Node、pnpm 的安全基线检查 |
| `pnpm security:android` | 解析 Android 全部 Maven 依赖并向 OSV 查询公告 |

`pnpm check` 不跑测试。新功能默认实际运行应用、截图验收，不自动新增测试；测试取舍见项目记忆的测试规范。

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| `apps/shared` | 两端共用的协议、数据模型、校验规则和 React 展示组件 |
| `apps/desktop` | Windows 电脑端：Electron 主进程、preload 和 React 界面 |
| `apps/mobile` | 移动端：React 网页层和 `android/` 下的 Capacitor 原生工程 |
| `scripts` | 检查、构建、版本和安全审计脚本 |
| `.project-memory` | 需求、架构、接口、决定和测试状态 |

## Android 构建与调试

```bash
pnpm android:build
pnpm android:open
```

debug APK 在 `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`。第一次构建要下载 Gradle、Android Gradle Plugin 和 Maven 依赖，网络不通时会停在下载这一步。

在 Android Studio 里连接已开启 USB 调试的手机即可运行。同时连了多台设备时，命令行用 `adb -s <serial>` 指定设备。换设备测试时，先确认系统版本和装的是哪个 APK，再重新选择存档目录，不要沿用另一台设备的目录。

`pnpm android:test` 不部署到设备；需要设备的测试和同步流程要在两台真机上另做验收，方法见项目记忆的 Android 平台层文档。

Android 工程由 Capacitor 生成，Manifest 允许明文 HTTP（局域网内两端直连），声明了只在用户发起传输时使用的 dataSync 前台服务，没有定时同步或开机任务。

## Android 签名

Android 只允许用同一把密钥签名的安装包覆盖安装。没有配置签名时，debug 包用本机的调试密钥，只能覆盖同一台机器构建的包。配置固定密钥后，debug 包和 release 包都用它签名，本机、其他机器和 CI 构建的包可以互相覆盖安装。

| 情况 | 要不要配密钥 | 说明 |
| --- | --- | --- |
| clone 后自己开发、调试 | 不用 | `pnpm android:build` 用本机调试密钥 |
| 多台机器构建、想互相覆盖安装 | 要 | 生成一把自己的密钥，每台机器配置同一份 |
| 构建 release 包（`pnpm android:build --release`） | 要 | 未配置时拒绝构建 |
| fork 后用 GitHub Actions 发布 | 要 | 在 fork 仓库配置 Secrets，否则发布工作流在开头就失败 |

自己的密钥签出的包和官方 Release 的包签名不同，不能互相覆盖安装。要换成另一方的包，先卸载已安装的应用（卸载的影响见[兼容性与卸载](#兼容性与卸载)）。

### 生成密钥

只需生成一次，按提示设置密码。PKCS12 密钥库的密钥密码与库密码相同。

```bash
keytool -genkeypair -v -keystore savedata-sync-release.jks -alias savedata-sync -keyalg RSA -keysize 4096 -validity 36500
```

`keytool` 在 JDK 的 `bin` 目录里。密钥文件放在仓库外，连同密码一起备份到至少两个地方。

### 本机配置

把 `apps/mobile/android/keystore.properties.example` 复制为同目录的 `keystore.properties`（已被 Git 忽略）并填写：

| 项 | 填什么 |
| --- | --- |
| `storeFile` | 密钥文件路径，用正斜杠，例如 `D:/keys/savedata-sync-release.jks` |
| `storePassword` | 生成时设置的密码 |
| `keyAlias` | `-alias` 的值，按上面的命令是 `savedata-sync` |
| `keyPassword` | 与 `storePassword` 相同 |

也可以改用环境变量 `SAVEDATA_SYNC_STORE_FILE`、`SAVEDATA_SYNC_STORE_PASSWORD`、`SAVEDATA_SYNC_KEY_ALIAS`、`SAVEDATA_SYNC_KEY_PASSWORD`，环境变量优先。四项要同时提供，缺一项构建直接失败。

配好后运行 `pnpm android:build --release`，产物在 `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`。

### GitHub Actions 配置

在仓库 Settings → Secrets and variables → Actions 添加四个 Repository secret：

| Secret | 填什么 |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | 密钥文件的 Base64。PowerShell 里运行 `[Convert]::ToBase64String([IO.File]::ReadAllBytes('D:\keys\savedata-sync-release.jks')) \| Set-Clipboard` 后粘贴 |
| `ANDROID_STORE_PASSWORD` | 同 `storePassword` |
| `ANDROID_KEY_ALIAS` | 同 `keyAlias` |
| `ANDROID_KEY_PASSWORD` | 同 `keyPassword` |

日常的仓库检查不需要这些 Secrets，只有推送 tag 触发的发布工作流需要。

### 密钥丢失或泄露

密钥无法找回，也不能从已发布的 APK 里恢复。丢失后只能生成新密钥，重新配置本机和 Secrets；已安装旧版本的用户必须卸载后才能安装新版本。发布这一版时，在 Release 说明里写明需要卸载重装，并提醒用户先处理移动端上的备份。Android 的密钥轮换需要用旧密钥签名，旧密钥丢失时用不了。

密钥或密码泄露后，别人可以做出能覆盖安装、并继承目录授权的冒充安装包。按丢失处理：换新密钥，替换 Secrets，并在 Release 说明里告知用户。

## 兼容性与卸载

应用是测试版，不保留旧版本的升级兼容代码：

- 配置和备份的存储格式变了，旧数据不迁移。电脑端读到旧格式的配置会报错，要删掉应用数据目录里对应的配置文件后重新添加游戏；移动端卸载重装。
- 两端之间的协议字段变了，两端必须更新到同一版本才能连接。

卸载移动端会清除游戏配置、目录授权和 `Android/data` 里的备份。电脑端卸载保留应用配置。

发布带不兼容改动的版本时，在 Release 说明里写明要怎么处理旧数据。

## 版本号与发布

### 版本号

版本号只来自 Git tag，仓库里不写版本号：各 `package.json` 的 `version` 固定为 `0.0.0`。`scripts/app-version.mjs` 计算本次构建的版本，两端界面、Windows 分发包和 Android 都从它取值。运行 `node scripts/app-version.mjs` 可以查看当前版本。

| 构建 | 版本名 | Android versionCode |
| --- | --- | --- |
| 发布工作流（环境变量 `RELEASE_TAG`），或当前提交正好是发布 tag 且工作区没有改动 | `0.3.0` | `major * 1000000 + minor * 1000 + patch`，0.3.0 为 3000 |
| 发布 tag 之后的开发构建 | `0.3.0+12.gcfb3753`，工作区有改动时末尾加 `.d` | 与最近的发布 tag 相同 |
| 找不到发布 tag（没有 git、浅克隆没拉 tag） | `0.0.0+unknown` | 1 |

- 发布 tag 是 `v<major>.<minor>.<patch>`，每段 0–999，不带前导零。带 `-` 的 tag（如预发布）不参与推算。
- 开发版和同一 tag 的正式版 versionCode 相同，配置固定签名后可以互相覆盖安装；下一个正式版的 versionCode 更大。
- Android 构建时 Gradle 会调用这个脚本，所以 PATH 里要有 Node。
- 开发服务器只在启动时计算一次版本，之后提交或改动文件不会更新界面上的版本号。
- Windows 分发包的文件名和 exe 文件版本只有 `0.3.0` 这样的数字部分，界面上显示完整版本。

### 发布步骤

只发布 master 上的提交。在 master 的最新提交上打 tag，和 master 一起推送：

```bash
git tag -a v0.3.0 -m "0.3.0"
```

```bash
git push --atomic origin master v0.3.0
```

`--atomic` 让 master 和 tag 要么都推送成功，要么都不推送。单独推送 tag 也可以，但 master 要先推送，否则发布工作流的检查会失败；推送 master 后在 Actions 页面重新运行即可。补丁版本同样在 master 上修复后打 tag，不使用发布分支。

推送 tag 会触发[发布工作流](../.github/workflows/release.yml)：

1. 确认 tag 格式正确、tag 指向的提交在 `origin/master` 上。
2. 运行 `pnpm check` 和 `pnpm test:all`。
3. 用 `pnpm desktop:package portable` 生成 Windows x64 免安装版。
4. 用 Secrets 里的固定密钥构建 Android release APK 并校验签名，生成 `SHA256SUMS.txt`。
5. 把三个文件上传为保留 7 天的 Actions artifact，并创建草稿 GitHub Release。

草稿说明由 GitHub 根据提交自动生成。发布前在 Release 页面补充本版的已知问题、安装限制和不兼容改动。创建草稿需要仓库的 Actions 工作流权限允许 `contents: write`。Windows 免安装版没有签名。

普通分支 push 和 PR 只运行仓库检查（`pnpm check` 和 `pnpm android:build`），不保存构建产物。

## 依赖安全检查

```bash
pnpm security:node
```

```bash
pnpm security:android
```

安全检查手动运行，日常 CI 不跑。两条命令都要联网，官方审计接口或 OSV 访问不了时命令失败。

- `security:node` 用官方 npm registry 审计全部 npm 依赖（含开发和间接依赖），单独向 OSV 查询固定的 pnpm 版本，并核对 Node 安全基线（`scripts/toolchain-policy.mjs`）。
- `security:android` 先同步 Android 工程，再解析全部可解析的 Maven 配置（各构建变体、测试、lint 等工具）和 buildscript classpath，写入 `.reports/android-dependencies.json`，然后向 OSV 查询这些版本和 Gradle Core。

改依赖时遵守这些规则：

- `pnpm-workspace.yaml` 的 `overrides` 让同一主版本的 npm 包只保留一个版本。跨主版本的多版本（如 `glob` 7 和 13）不强行合并，等上游升级。
- `pnpm-workspace.yaml` 的 `peerDependencyRules` 允许 eslint-plugin-react 7.37 搭配 ESLint 10：插件的 peer 范围还停在 ESLint 9，项目用到的规则在 ESLint 10 上能正常运行。
- Gradle 分发 ZIP 固定官方 SHA-256，下载内容不符时构建失败。
- `apps/mobile/android/dependency-security.json` 统一修补 Android 构建的间接库版本。同一 Maven 模块全项目只解析一个版本，版本写在 `singleVersionModules`，一般取出现过的最高版；`listenablefuture` 固定 1.0（`9999.0-empty` 是空包，APK 不带 Guava）。`security:android` 发现多版本时失败。
- CI 固定 Action 的 commit SHA，使用 JDK 21 和 runner 预装的 SDK。

最近一次审计结果和未处理的公告记在项目记忆的回归记录里。

## 常见问题

**`pnpm doctor` 报缺少工具。** 检查脚本只读取环境，不安装软件，也不替你接受 SDK licenses。按提示安装后重新运行，或在 `dev.local.json` 里填路径。

**电脑端第一次启动很慢。** Electron 第一次运行时会下载运行时。可以先运行 `pnpm --filter @savedata-sync/desktop exec electron --version` 确认下载成功。

**电脑端开发版启动就报配置错误。** 本机的应用配置还是旧格式，见[兼容性与卸载](#兼容性与卸载)。

**只读检查发现文件的 ctime 变了。** 有的文档提供者在首次授权读取后会改 ctime。判断内容是否一致时看原文、大小和 mtime。
