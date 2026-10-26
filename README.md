# Galgame SaveData Sync

Windows 与 Android 的局域网文件夹同步工具，正在开发中。目录读取、私有归档和双端原生 HTTP 传输已经可用；界面仍是空壳，完整的文件夹同步还没完成。Windows 服务由可信主进程启动，接收文件还需要单独的本机写授权。

## 目录

- [技术栈与范围](#技术栈与范围)
- [快速开始](#快速开始)
- [开发命令](#开发命令)
- [仓库结构](#仓库结构)
- [项目记忆](#项目记忆)

## 技术栈与范围

- React 18 + TypeScript + Vite，pnpm workspace 管理双端与共享包。
- Windows：Electron + Ant Design；Android：Capacitor 8 + Ant Design Mobile。
- Android 最低 API 29，编译/目标 API 36；用户发起的传输通过持续通知/前台服务保持，切后台继续已有任务。
- 目标连接方式是明文 HTTP、设备发现列表与手动 IP；同步时手选方向，默认覆盖复制，可选镜像，覆盖前备份。
- 同步以本次当前目录为准，不保存历史基线；文件夹不递归统计大小。

## 快速开始

建议使用 Node.js 22.23.4+（22.x）或 24.22.1+（24.x）安全补丁、pnpm 10.34.8、Git。Android 原生开发的 JDK、SDK 与 IDE 设置见[本地开发指南](docs/development.md)。

```sh
pnpm install --frozen-lockfile
pnpm env:check --desktop
pnpm dev:desktop
```

预览移动端网页外壳：

```sh
pnpm dev:mobile
```

Windows PowerShell 若限制执行 `.ps1` 启动器，可使用 `pnpm.cmd` 执行同样的命令。开发服务器默认只监听本机；Android 运行本地打包资源，不依赖开发服务器地址。

## 开发命令

| 命令                       | 用途                                                              |
| -------------------------- | ----------------------------------------------------------------- |
| `pnpm env:check`           | 检查桌面和 Android 工具，输出 OK / WARN / FAIL；FAIL 时退出码为 1 |
| `pnpm env:check --desktop` | 检查桌面环境与工具，不要求 Android 环境                           |
| `pnpm dev:desktop`         | 启动 Electron 开发模式                                            |
| `pnpm dev:mobile`          | 启动移动界面的本机网页预览                                        |
| `pnpm check`               | 编码/换行、格式、ESLint、类型检查和双端构建                       |
| `pnpm test:all`            | 全量自动化测试及 Android 原生测试；用于发布或高风险改动            |
| `pnpm security:check`      | 官方 npm 全量审计、固定 pnpm 的 OSV 检查及 Node.js 安全补丁基线   |
| `pnpm security:npm`        | 审计项目全部 npm 直接和间接依赖，包括开发依赖                     |
| `pnpm security:android`    | Gradle 解析 Android 运行、测试及构建依赖后通过 OSV 检查 Maven 包  |
| `pnpm format`              | 格式化手写代码；Markdown 与生成的 Android 工程单独维护          |
| `pnpm android:sync`        | 构建移动网页并同步到已纳入仓库的 Android 工程                     |
| `pnpm android:build`       | 同步资源后使用项目 Gradle Wrapper 构建 debug APK                  |
| `pnpm android:test`        | Java 单元、跨端原生归档互通、Android lint 及调试/仪器测试 APK 构建，不自动连接设备 |
| `pnpm android:open`        | 在配置的 Android Studio 中打开原生工程                            |

构建命令生成的是未打包、未签名的开发版本。功能改动优先用 lint、类型检查、构建和实际操作验证；`pnpm test:all` 用于发布前或高风险改动。

## 仓库结构

```text
apps/desktop/       Electron 主进程、受限 preload 与 antd 界面
apps/mobile/        antd-mobile 界面与 Capacitor 配置
apps/mobile/android/  Android 原生工程、Gradle Wrapper
packages/shared/    双端共用的 TypeScript 导出
scripts/            环境检查、文本检查、Android 构建和 IDE 入口
docs/               开发指南
.github/workflows/  Windows 环境下的仓库检查
.project-memory/    已确认需求、方案、验收和当前状态
```

## 项目记忆

先读取[记忆索引](.project-memory/INDEX.md)，再按任务定位需求、架构、规范与当前工作。目录读取与私有归档接口见[桌面适配](apps/desktop/README.md)和[移动适配](apps/mobile/README.md)。
