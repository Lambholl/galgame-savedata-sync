# Galgame SaveData Sync

Windows 与 Android 的局域网文件夹同步工具，正在开发中。现在可以在双端选择和浏览目录，在手机手动连接电脑、选择方向并传输文件。M-001 验证界面使用独立测试目录，只新建文件；完整的文件夹同步还没完成。

## 目录

- [技术栈与范围](#技术栈与范围)
- [快速开始](#快速开始)
- [验证文件往返](#验证文件往返)
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

预览移动端界面：

```sh
pnpm dev:mobile
```

Windows PowerShell 若限制执行 `.ps1` 启动器，可使用 `pnpm.cmd` 执行同样的命令。开发服务器默认只监听本机；Android 运行本地打包资源，不依赖开发服务器地址。

## 验证文件往返

1. 电脑到“设备”页启动本机服务，复制显示的完整 HTTP 地址。端口填 0 会分配可用端口。
2. 到“游戏”页添加游戏，进入“目录设置”选择电脑上的存档目录。接收文件前，用“允许接收新文件”选择独立测试目录并确认。
3. 手机安装 Android 调试包，到“设备”页添加电脑地址并连接。同一时间连接一台设备，保存的其它设备与游戏关联会保留。
4. 手机到“游戏”页导入电脑上的游戏，再在目录设置中选择手机目录。已有本机游戏也可明确选择对端游戏进行关联；一个游戏可关联多台设备，每端只设置自己的目录。
5. 从游戏操作面板进入“传输存档”，选择本次对端与方向，并排查看两端当前层文件。确认源文件与目标位置后预览，必要时修改目标名称，再开始传输并允许通知。接收端“目标写入成功”才表示文件已写入；切后台后已有传输继续运行。

同名目标会报错，已写入成功的文件在取消后保留。真实存档请使用只读入口。目录展开和刷新读取当前层，文件夹大小显示“—”。

## 开发命令

| 命令                       | 用途                                                              |
| -------------------------- | ----------------------------------------------------------------- |
| `pnpm env:check`           | 检查桌面和 Android 工具，输出 OK / WARN / FAIL；FAIL 时退出码为 1 |
| `pnpm env:check --desktop` | 检查桌面环境与工具，不要求 Android 环境                           |
| `pnpm dev:desktop`         | 启动 Electron 开发模式                                            |
| `pnpm desktop:package`     | 构建 Windows x64 安装版与免安装版 exe，输出到 apps/desktop/release |
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

`pnpm build` 生成运行资源；`pnpm desktop:package` 生成未签名的 Windows 分发包，`pnpm android:build` 生成 Android 调试 APK。功能改动优先用 lint、类型检查、构建和实际操作验证；`pnpm test:all` 用于发布前或高风险改动。

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
