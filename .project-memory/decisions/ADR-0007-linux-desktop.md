---
doc_type: adr
status: accepted
updated: 2026-11-26
tags: [决策, Linux, 电脑端, 分发, 平台标识, 迁移, 符号链接]
---

# ADR-0007 电脑端支持 Linux：分发形式、平台标识、迁移链和符号链接

## 目录

- [状态](#状态)
- [替代关系](#替代关系)
- [背景](#背景)
- [决策](#决策)
  - [支持范围与分发](#支持范围与分发)
  - [便携模式](#便携模式)
  - [平台标识](#平台标识)
  - [落盘格式迁移链](#落盘格式迁移链)
  - [符号链接和特殊文件](#符号链接和特殊文件)
- [原因](#原因)
- [影响](#影响)
  - [正面影响](#正面影响)
  - [负面影响](#负面影响)
- [替代方案](#替代方案)
- [相关文件](#相关文件)

## 状态

accepted。迁移链（第 11 至 15 条）和符号链接与特殊文件（第 16、17 条）已实现，其余还没实现；随 1.1.0 发布，拆分和进度见[工作包登记](../development/work-packages.md)和[路线图](../project/roadmap.md) M-007。

## 替代关系

| 被替代 ADR | 原路径 | 原因 |
| --- | --- | --- |
| 无 | 无 | 新决策；补充 [ADR-0005](ADR-0005-tauri-sidecar-and-storage-layout.md) 第 6 条（分发）和第 11 条（便携模式）在 Linux 上的取值，细化 [ADR-0006](ADR-0006-stable-release-compatibility.md) 第 8 条迁移代码的结构 |

## 背景

- ADR-0005 已经按 XDG 规划了 Linux 的存储目录，`storage.rs` 也有 Linux 分支；其余部分只在 Windows 上构建和测试过。
- 推荐地址模块用 `route print` 和 `reg query`，不是 Windows 时直接报错（`recommended-address.ts`）。sidecar 构建和打包脚本只能在 Windows x64 上运行，CI 和发布工作流只有 `windows-latest`。
- 协议、发现广播和游戏库里的设备平台只有 `'windows' | 'android'`。共享包 `library.ts` 和 Android `ListenerLibrary.java` 严格校验这个字段：1.0 读到其他值时整份游戏库校验失败，按读不懂的数据处理，电脑端改名保留后用空游戏库启动，Android 删除这份数据。
- 1.0.0 已发布，ADR-0006 的兼容规则生效；1.0.0 不含迁移代码。
- `directory-paths.ts` 遇到路径上任意一级是符号链接就拒绝访问，`directory-adapter.ts` 在目录里遇到文件和文件夹以外的条目时整个目录列不出来。Linux 上存档常在 Wine 或 Proton 前缀里，Steam 目录和前缀内部有大量符号链接，部分发行版的 `/home` 本身是符号链接，按现有规则很多存档目录用不了。

## 决策

### 支持范围与分发

1. 只支持 x86_64。最低支持 Ubuntu 22.04 和 Debian 12；Tauri 2 依赖 WebKitGTK 4.1，更早的发行版没有这个版本。
2. 发布 AppImage 和 deb 两种。不发免安装的二进制 tar.gz，免安装的场景由 AppImage 承担；不做 rpm 和 Flatpak。
3. 发布包在 `ubuntu-22.04` 上构建，二进制要求的 glibc 不高于 2.35。
4. sidecar 用 `@yao-pkg/pkg` 的 linux-x64 目标编译，内嵌的 Node 主版本与 Windows 相同，作为 Tauri externalBin，目标三元组为 `x86_64-unknown-linux-gnu`。
5. 存储目录沿用 ADR-0005 第 7 条的 XDG 位置。

### 便携模式

6. AppImage 以 `.AppImage` 文件所在的文件夹（环境变量 `APPIMAGE` 的父目录）判断便携模式：那里有 `portable_data` 文件夹时，四个目录换成它下面的 `config`、`data`、`backups`、`cache`。AppImage 运行时主程序位于临时挂载点，不按主程序路径判断。
7. deb 安装版不支持便携模式，始终使用 XDG 目录。

### 平台标识

8. 设备平台增加 `'linux'`，用于协议的设备描述、发现广播 TXT 和游戏库保存的设备。界面上 `'linux'` 和 `'windows'` 一样按电脑显示（电脑图标、`pc` 类型）；封面请求的 User-Agent 写 Linux。
9. 1.1.0 的 `PROTOCOL_VERSION` 为 5（1.0 为 4），两端要一起更新到 1.1.0，发布说明写明。
10. 1.1.0 的游戏库版本为 3（1.0 为 2），即共享包 `LIBRARY_SCHEMA_VERSION` 和 Android `ListenerLibrary.LIBRARY_VERSION`。从 2 到 3 的数据不用转换，迁移步骤原样返回；版本号加一的作用是让降级回 1.0 的应用按 ADR-0006 第 9 条拒绝启动，而不是把含 `'linux'` 的游戏库当成损坏数据（Android 上会被删除）。

### 落盘格式迁移链

11. 每种带 `schemaVersion` 的结构化数据（ADR-0006 第 5 条列出的各项）有一条迁移链：按版本排列的迁移步骤，每步把版本 n 的数据变成版本 n+1，是只操作已解析 JSON 的纯函数，不读写文件。
12. 读取时按 `schemaVersion` 处理：
   - 等于当前版本：直接校验。
   - 小于 1.0 的基线版本：按读不懂的数据处理（ADR-0006 第 7 条）。
   - 介于基线和当前版本之间：从读到的版本起逐步执行到当前版本，再按当前格式校验；任何一步失败或校验不通过都按读不懂的数据处理。迁移成功后写回，写法与该数据现有的保存方式相同（临时文件加改名）。
   - 大于当前版本：按 ADR-0006 第 9 条处理。
13. 迁移在启动检查读取这项数据之前完成。
14. 共享包提供一份通用的执行函数，各数据只登记自己的基线版本、当前版本和步骤表；Android 用 Java 实现同样的结构。以后改格式时只加一个步骤并把当前版本加一，不改执行函数。
15. 单元测试检查每条链从基线到当前版本连续、没有缺号。每个已发布过的版本保留一份样本（`apps/desktop/test/fixtures/compat` 和 Android 对应的测试资源），测试确认每份样本都能迁移到当前版本并通过校验。旧版本的样本不删除。

### 符号链接和特殊文件

16. 选择同步目录和备份库时，把系统选择器返回的路径解析成真实路径（`realpath`）再登记。登记后的路径不含符号链接，访问时仍按现有规则拒绝路径中途出现的符号链接。两个平台都按这条处理，Windows 上的目录联接同样解析。
17. 同步目录里的符号链接、FIFO、套接字和设备文件不影响同一目录里其他条目的读取，也不参与同步：和 `.nomedia` 一样不出现在目录列表、扫描、计划和备份里，不作为来源复制，不跟随到链接目标，不改协议。目标端有同名的这类条目时，计划预见不到，写入那一步因名称已存在而失败；选择“删除目标多出的条目”时也不删除它们，只剩这类条目的文件夹删除失败。结论见 [Q-026](../requirements/open-questions.md)。

## 原因

- AppImage 和 deb 覆盖了 Linux 桌面上最常见的两种安装方式：deb 用系统的 WebKitGTK，包小、能随系统更新；AppImage 不依赖发行版的软件包，可以放在任意文件夹，兼作免安装版。
- `ubuntu-22.04` 是 Tauri 2 能构建的最早的 Ubuntu LTS，在它上面构建的二进制在更新的发行版上也能运行。
- `'linux'` 让设备列表、日志和请求头如实反映平台；协议版本在 1.1.0 本来就要求两端同版，这时加字段值不另外增加升级负担。
- 迁移链只登记步骤，以后改格式时不用改动读取流程；样本和连续性测试保证升级路径不会漏掉中间版本。
- 存档目录本身很少是符号链接，问题出在路径上层和目录里的个别条目；先解析真实路径、跳过特殊条目，就能用 Wine 和 Proton 的目录，同时不放开跟随链接带来的越界写入。

## 影响

### 正面影响

- Linux 电脑能与 Windows 和 Android 设备互传。
- 迁移链在第一次改格式时建好，后续格式变化只需增加步骤。
- 通过符号链接或目录联接选择的目录可以使用。

### 负面影响

- 1.1.0 起协议和游戏库的版本都变了，Windows 和 Android 要一起升级；降级回 1.0 的应用会因为游戏库版本更新而拒绝启动。
- 1.0 的设备收到 `'linux'` 的发现广播或握手时，可能直接丢弃或报格式错误，而不是提示版本不同；这取决于 1.0 先校验版本还是平台字段，还没测。
- AppImage 内含 WebKitGTK，体积比 deb 大；Ubuntu 22.04 及以后要另装 `libfuse2` 才能直接运行 AppImage。
- 发布工作流要增加 Linux 构建，Rust 和 WebKitGTK 的构建依赖要进 CI。
- Linux 上没有 Windows 防火墙那样的首次运行提示，开着 ufw 或 firewalld 时端口要用户自己放行。

## 替代方案

| 方案 | 优点 | 缺点 | 结果 |
| --- | --- | --- | --- |
| Linux 继续上报 `'windows'` | 不改协议和游戏库格式 | 平台信息与实际不符，User-Agent 写错；以后要区分平台时还得改协议 | rejected |
| 加 `'linux'` 但不升游戏库版本 | 少一次版本变化 | 降级回 1.0 时游戏库被当成损坏数据，Android 上会被删除 | rejected |
| 另发免安装的二进制 tar.gz | 不需要 FUSE | 与 AppImage 用途重复，还要用户自己装 WebKitGTK | rejected |
| 发 rpm 或 Flatpak | 覆盖 Fedora 或沙箱分发 | 要另外在 Fedora 上验收，或维护 Flatpak 清单和沙箱权限 | rejected |
| 保持符号链接一律拒绝 | 不改安全边界 | Wine、Proton 和 Steam 目录大多不能用 | rejected |
| 跟随同一根目录内的符号链接 | 能同步链接指向的内容 | 要防止链接指向根目录外，写入目标端时还要决定写链接还是写内容，复杂度和越界风险都高 | rejected |

## 相关文件

| 文件 | 说明 |
| --- | --- |
| `apps/desktop/src-tauri/src/storage.rs` | 存储目录和便携模式判断 |
| `apps/desktop/scripts/build-sidecar-exe.mjs`、`package-windows.mjs` | sidecar 编译和打包，要增加 Linux 目标 |
| `apps/desktop/src/backend/recommended-address.ts` | 推荐地址，Windows 和 Linux 各有实现 |
| `apps/desktop/src/backend/directory-paths.ts`、`directory-adapter.ts` | 符号链接和特殊条目处理 |
| `apps/shared/src/protocol/contracts.ts`、`validation.ts`、`apps/shared/src/connection/discovery.ts` | 设备平台的协议定义和校验 |
| `apps/shared/src/library/library.ts`、`apps/mobile/android/.../ListenerLibrary.java`、`TransferSchema.java` | 游戏库版本和平台校验 |
| `.github/workflows/ci.yml`、`release.yml` | CI 和发布 |
