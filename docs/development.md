# 本地开发指南

## 目录

- [环境要求](#环境要求)
- [机器路径配置](#机器路径配置)
- [Android 工作流](#android-工作流)
- [依赖安全检查](#依赖安全检查)
- [验证范围与常见问题](#验证范围与常见问题)

## 环境要求

| 工具                   | 仓库要求                                                       |
| ---------------------- | -------------------------------------------------------------- |
| Node.js                | 功能最低 22.13；安全基线为 22.23.4+（22.x）或 24.22.1+（24.x） |
| pnpm                   | 固定 10.34.8，与 `packageManager` 一致                         |
| Git                    | 本地仓库管理；初始化不包含提交或远端发布                       |
| JDK                    | 建议 JDK 21.0.13+ 安全补丁；Gradle 8.14.6，需包含 `javac`      |
| Android SDK            | Platform 36、Build Tools 35.0.0 或更新、Platform Tools         |
| Android Studio         | 2025.2.1 或更新；可通过 SDK Manager 管理工具和原生工程         |
| SDK Command-line Tools | 推荐安装 latest，用于 `sdkmanager` 管理和修复 SDK              |

Android 应用最低运行版本是 API 29，不需要安装 API 29 平台才能编译；使用 API 36 编译。API 29 真机或模拟器用于后续兼容性验证。

依赖固定在各 `package.json` 与 `pnpm-lock.yaml`。React 18 用于满足当前 antd-mobile 间接动画依赖的 peer 要求，不关闭严格依赖检查。TypeScript 5.9 与所选 ESLint / typescript-eslint 版本配套。

参考：[Capacitor 8 环境](https://capacitorjs.com/docs/getting-started/environment-setup)、[Android 工程要求](https://capacitorjs.com/docs/updating/8-0)。

## 机器路径配置

项目不修改全局 PATH、JAVA_HOME 或 SDK 环境变量。可将 `dev.local.example.json` 复制为 Git 忽略的 `dev.local.json`，填写绝对路径：

```json
{
  "androidSdk": "C:/path/to/Android/Sdk",
  "javaHome": "C:/path/to/jdk-21",
  "androidStudio": "C:/path/to/Android Studio/bin/studio64.exe",
  "gradleProxy": ""
}
```

空字符串表示未指定。优先使用该文件，然后读取 `JAVA_HOME`、`ANDROID_HOME` / `ANDROID_SDK_ROOT` 和 `CAPACITOR_ANDROID_STUDIO_PATH`；SDK 另检查 Windows 常见位置。填写错误时不会静默忽略 JSON 格式问题。

`pnpm android:build` 只对子进程设置 JDK / SDK 变量，使用仓库的 Gradle Wrapper，不使用机器全局的 Gradle。`pnpm android:open` 读取上述 IDE 路径。Android Studio 内的 Gradle JDK 仍需在 IDE 设置中选择同一个 JDK 21。

需要代理时，在 `gradleProxy` 填写无凭据的 HTTP 代理端点。该配置仅作用于 Gradle 子进程，不修改系统代理或 TLS 校验。

## Android 工作流

```sh
pnpm env:check
pnpm android:sync
pnpm android:build
pnpm android:test
```

debug APK 输出到 `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`。首次构建需要下载 Gradle、Android Gradle Plugin 和 Maven 依赖；工具检测通过不等于这些网络资源一定可以下载。

```sh
pnpm android:open
```

连接已开启 USB 调试的设备后，可在 Android Studio 运行应用。Java SAF 读取插件已实现，界面仍为空壳；插件入口、原生流责任、自动与交互测试见[移动适配说明](../apps/mobile/README.md)。`android:test` 执行 Java 单元、Android lint 及调试/测试 APK 构建，不自动部署设备；启动成功不等于同步业务验收。

## 依赖安全检查

```sh
pnpm security:check
pnpm security:android
```

检查包含开发和间接 npm 依赖；官方审计接口不可访问时失败，不能把未完成当作零漏洞。项目配置及安全命令显式使用官方 npm registry。

- pnpm 固定 10.34.8，并单独查询 OSV，因为包管理器不属于业务 lockfile 依赖树。
- `xcode>uuid` 精确覆盖为 11.1.1，修复 [GHSA-w5hq-g745-h8pq](https://github.com/uuidjs/uuid/security/advisories/GHSA-w5hq-g745-h8pq)。选择仍支持 CommonJS 的修复版本，已验证 xcode 的 UUID 生成调用兼容；不全局强制所有包升级主版本。
- Gradle 采用 [8.14.6 安全补丁](https://docs.gradle.org/8.14.6/release-notes.html)，分发 ZIP 固定官方 SHA-256，下载或哈希失败不绕过校验。
- Android Gradle Plugin 升级至兼容的 8.13.2。`apps/mobile/android/dependency-security.json` 统一修补构建间接库：Netty 保持兼容的 4.1 分支，压缩、JOSE、Bouncy Castle 和 JDOM 使用经 OSV 检查的修复版本；Protobuf 3.x 修补至 3.25.9，不降级独立的 4.x 请求。策略同时覆盖生成项目的 buildscript 和普通依赖，不修改 node_modules。未使用的 Google Services 构建插件已移除。
- `security:android` 先构建移动网页并执行 Capacitor 同步，生成 Git 忽略的 Cordova 工程，再重新解析全部可解析的 Maven 配置（包括各构建变体、测试、lint 等工具）及 buildscript classpath，写入 Git 忽略的 `.reports/android-dependencies.json`，并向 OSV 查询这些版本和 Gradle Core。生成、解析或查询失败均不报告通过。
- CI 固定 Action commit SHA，使用 JDK 21 和 runner 预装 SDK，并执行 `pnpm check`、`pnpm android:test`、`pnpm security:check` 及 `pnpm security:android`。Node.js 安全基线见 `scripts/toolchain-policy.mjs`，后续需跟随官方安全发布维护。

2026-10-25 项目依赖审计结果：官方 npm 全量 397 项零已知漏洞；Android 全部可解析 Maven 配置与 Gradle Core 共 273 项零已知公告；固定 pnpm 10.34.8 单独 OSV 查询零公告。

Windows 构建产物的 renderer 与隔离 preload 已通过启动检查；Android debug APK 已构建成功，并读取其 Manifest 确认 minSdk 29、targetSdk 36、明文 HTTP 允许。Java SAF 在 API 33 的独立合成夹具复测完整收齐非交互与选择/取消/重启回执；旧 API 35 真实目录的 11 文件校验仅适用于旧设备；Windows HTTP sender 已通过独立回环测试，尚无正式双端 LAN 往返和目录同步验收，API 29 仍有缺口。

审计结果只代表当前已知公告，不能替代真机验证或证明系统 JDK/SDK 二进制没有漏洞。Android 原生构建与依赖解析的实际结果记录在项目记忆中。

## 验证范围与常见问题

- `pnpm test:shared` 执行共享包的纯数据契约测试，无需连接设备或网络；类型反例随 `pnpm typecheck` 检查。完整契约、线格式和示例见[共享包说明](../packages/shared/README.md)。
- `pnpm test:desktop` 执行 Windows 临时目录、有限 IPC 和私有归档测试，已接入 `pnpm check`；接口、缓存及资源责任见[桌面适配说明](../apps/desktop/README.md)。目录读取和归档已实现，当前 UI 按钮尚未接入。
- `pnpm test:mobile` 检查 SAF 桥请求/响应边界，已接入 `pnpm check`；Android 真机授权、提供者及原生流需另行仪器测试。
- `pnpm check` 包含共享、桌面、移动桥测试及双端构建；Windows 私有缓存不构成目标发布，目标文件写入、HTTP receiver/Android 网络和完整跨端传输仍待后续工作包；Windows sender/会话注册已实现，构造不启动监听，服务控制界面留后续包。真实用户目录仅做只读验证，写入/失败测试使用独立临时夹具。
- `pnpm env:check --json` 提供结构化检查；`--desktop` 排除 Android 工具。WARN 不导致失败，FAIL 的退出码为 1。
- 更换或连接多台设备时，用 `adb -s <serial>` 明确固定目标；重查实际系统版本与已安装 APK，重新选择本机目录，不复用其它设备的路径或测试结论。缺少完整回执的批次不作为通过证据。
- 只读检查分别比对内容、大小、mtime 和其它状态时间。API 33 合成夹具首次 SAF 授权/读取后曾观察到 ctime 变化，原文、大小和 mtime 一致，后续重复读取完整快照一致；归因仍未确定。不能将只读接口解释为所有提供者下 ctime 必定不变。
- 检查脚本不自动安装软件、不修改全局环境、不接受或补签 SDK licenses。
- Electron 45 首次运行时按需下载运行时；`pnpm --filter @savedata-sync/desktop exec electron --version` 可验证下载和执行。环境检查只读取安装结果，不触发下载。
- 移动网页预览可在缺少 Android Studio 时开发；APK 编译与真机验证需要单独完成。
- CI 执行格式、lint、类型、基础设施/共享/桌面/移动桥测试、Web/Electron 构建、Java 单元/Android lint/双 APK 及 npm/Maven/工具链安全检查；远端执行结果见项目记忆，不代表真机业务流程已经通过。
- Android 原生工程为 Capacitor 生成，保留 Gradle Wrapper；`minSdkVersion = 29`、`compileSdkVersion = targetSdkVersion = 36`，Manifest 允许明文 HTTP。未增加后台服务或后台任务。
