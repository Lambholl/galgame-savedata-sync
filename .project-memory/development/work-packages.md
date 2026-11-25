---
doc_type: work-packages
status: active
id_prefix: WP
id_high_water: 83
updated: 2026-11-26
tags: [工作包]
---

# 工作包登记

## 目录

- [1. 当前工作包](#1-当前工作包)
- [2. 执行与拆分规则](#2-执行与拆分规则)

## 1. 当前工作包

已完成的工作包结论吸收到架构、实现细节和测试文档后删除，历史由 Git 保存。

| ID | 工作包 | 内容与完成标准 | 依赖 | 状态 |
| --- | --- | --- | --- | --- |
| WP-076 | 电脑端去掉 Windows 命名 | 后端 `Windows*` 类名和类型名改成平台无关的名称（命名在开工时定），只做机械替换、单独提交；记忆里的 `architecture/windows.md` 改为电脑端平台层，更新引用它的链接和术语表的“复制任务”行。完成标准：`pnpm check` 和桌面端测试通过，行为不变 | 无 | planned |
| WP-077 | 后端在 Linux 上运行 | 推荐地址增加 Linux 实现：读 `/proc/net/route` 取默认路由和 metric，按 `/sys/class/net/<网卡>/device` 是否存在判断物理网卡，不调用外部命令，解析函数有单元测试；设备名取系统主机名；修复 Linux 上暴露的测试失败，处理只针对 Windows 8.3 短路径的测试。目前 Linux 上桌面端 36 项测试有 3 项失败：`compat-samples.test.mjs` 的两项，原因是电脑端 `directories` v2 样本里的根目录是 Windows 路径，在 Linux 上不是绝对路径，被当成读不懂的数据，要定下平台相关的样本怎样在另一个平台上核对（样本已冻结，不能改）；`http-service.test.mjs` 的一项见 BUG-032。完成标准：桌面端测试和 `release:loopback` 在 Linux 上通过 | 无 | planned |
| WP-078 | 符号链接和特殊文件 | 按 [ADR-0007](../decisions/ADR-0007-linux-desktop.md#符号链接和特殊文件) 第 16、17 条：选择同步目录和备份库时解析真实路径；目录里有符号链接、FIFO、套接字和设备文件时其他条目照常列出，这些条目不参与同步。开工前由维护者回答 [Q-026](../requirements/open-questions.md)。完成标准：两个平台的目录适配器、扫描和写入测试覆盖符号链接和特殊条目，Windows 目录联接的回归通过 | WP-077、Q-026 | planned |
| WP-079 | 落盘格式迁移链 | 按 [ADR-0007](../decisions/ADR-0007-linux-desktop.md#落盘格式迁移链) 第 11 至 15 条，在共享包和 Android 各实现一份迁移执行函数和步骤登记，接入 ADR-0006 第 5 条列出的全部结构化数据（当前都没有步骤）。完成标准：连续性测试和 1.0 样本测试通过；读到更新版本、0.x 版本和迁移失败时的处理有测试 | 无 | planned |
| WP-080 | 设备平台增加 linux | 协议设备描述、发现 TXT、游戏库和 Android `TransferSchema`、`ListenerLibrary` 接受 `'linux'`；`PROTOCOL_VERSION` 升到 5；游戏库版本两端都升到 3，迁移步骤原样返回，加 v2 样本测试；界面按电脑显示，封面 User-Agent 写 Linux；sidecar 在 Linux 上上报 `'linux'`。完成标准：共享包、桌面端和 Android 单元测试通过；Android 与 1.1.0 电脑端互连正常；记录 1.0 设备遇到 Linux 设备时的实际表现 | WP-079 | planned |
| WP-081 | Tauri 宿主在 Linux 上运行 | 先解决 BUG-033（Linux 窗口图标），之后 `pnpm lint` 才能在 Linux 上跑完；`pnpm dev:desktop` 在 Linux 桌面上可用：sidecar 启停和退出顺序、目录和图片选择器、打开文件夹、单实例、跟随系统明暗和窗口背景、中日文字体；在 WebKitGTK 上按 [界面约定](ui-conventions.md) 过一遍各页面。完成标准：X11 和 Wayland 会话各验收一次，差异写进平台层文档 | WP-077 | planned |
| WP-082 | Linux 打包、CI 和发布 | sidecar 增加 linux-x64 目标；打包脚本在 Linux 上产出 AppImage 和 deb（deb 声明 WebKitGTK 4.1 依赖）；AppImage 按 `APPIMAGE` 判断便携模式（`storage.rs`）；CI 增加 `ubuntu-22.04` 的 `pnpm check` 和桌面端测试，发布工作流增加 Linux 产物。完成标准：在没装开发依赖的 Ubuntu 22.04 和 Debian 12 上安装 deb、运行 AppImage 并完成一次传输 | WP-080、WP-081 | planned |
| WP-083 | Linux 实机验收和用户文档 | 实机验收 Linux 与 Android、Linux 与 Windows 双向传输，Wine 或 Proton 前缀里的存档目录，系统已运行 avahi-daemon 时的自动发现，ufw 或 firewalld 开启时的连接；README 增加 Linux 下载、`libfuse2` 和防火墙放行说明；把 REQ-027 并入 REQ-001，更新范围和约束里的平台，验收结果写进测试文档。完成标准：验收场景全部通过，或未通过项登记在已知问题 | WP-078、WP-082 | planned |

## 2. 执行与拆分规则

- 一包承担一个主要能力边界。跨平台协议变更、提供者差异、无法独立验证或新增依赖/配置迁移使范围扩大时先拆包；保留原包交接，同一交付物只写在一个包。
- 实现前读取目标路径实际存在且适用的 `AGENTS.md`、项目编码规范和目标语言规则。设计授权不包含实现或提交权限。
- 工作包完成以针对性检查、受影响工程检查和明确剩余缺口为证据；没有真机证据的项保持未完成。完成、阻塞和下一步同步 INDEX、模块状态、用例和回归状态。
- 每个工作包开始前重新读取记忆并细化。
- 不授权并行 Agent。
