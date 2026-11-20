<div align="center">

<img src="assets/app-logo.png" alt="Galgame SaveData Sync" width="256">

# Galgame SaveData Sync

Windows 与 Android 的局域网文件夹同步工具。

[![Release](https://img.shields.io/github/v/release/Lambholl/galgame-savedata-sync?style=flat-square&label=release)](https://github.com/Lambholl/galgame-savedata-sync/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/Lambholl/galgame-savedata-sync/total?style=flat-square&logo=github)](https://github.com/Lambholl/galgame-savedata-sync/releases)
[![License](https://img.shields.io/github/license/Lambholl/galgame-savedata-sync?style=flat-square)](LICENSE)

[下载](#下载) · [使用](#使用) · [常见问题](#常见问题) · [构建](#从源码构建) · [开发指南](docs/development.md)

</div>

## 功能

- **两端直连**：电脑和手机在同一个网络里直接互传，不经过云端，不需要注册账号。
- **文件比较**：传输前比较两端的整个存档目录，列出要新建、覆盖和删除的文件，确认后才写入。
- **存档备份**：每次写入前自动备份目标目录，出错可恢复。
- **便捷连接**：自动发现同一网络里的设备，也可以扫二维码或手动输入地址；电脑换了 IP，手机会自动找到新地址。
- **后台传输**：手机切到后台继续传输，通知栏显示进度。
- **免费开源**：采用 GNU AGPL v3.0 许可。

应用还是测试版，不同版本之间可能不兼容，两台设备请装同一个版本。

## 下载

在 [GitHub Releases](https://github.com/Lambholl/galgame-savedata-sync/releases/latest) 下载对应设备的文件。想确认文件没有损坏，可以对照同一页面的 `SHA256SUMS.txt`。

| 平台 | 安装包 | 说明 |
| --- | --- | --- |
| Windows 10+ | `SavedataSync-<版本>-Portable-x64.exe` | 64 位，免安装，双击运行 |
| Android 11+ | `SavedataSync-<版本>-Android.apk` | 安装时系统会要求允许这个来源安装未知应用 |

**Windows 提示“已保护你的电脑”**

程序没有数字签名，点“更多信息”→“仍要运行”即可。

## 使用

**第一次连接**

1. 电脑上打开应用，在“设备”页点“启动本机服务”。Windows 防火墙弹出询问时，允许它在专用网络上通信。
2. 手机和电脑连同一个 Wi-Fi，或者连接移动热点。
3. 手机上打开应用，在“设备”页的“附近的设备”里找到电脑，点“连接”。  
找不到电脑时，可在电脑设备页点“显示二维码”，用手机设备页右上角的扫码按钮扫描；或在扫码页选“手动输入”，填入电脑显示的 IP 地址和端口。

连过一次后，手机会记住这台电脑，下次在“已保存的设备”里点“连接”就行。一台电脑同一时间只连一台手机。

**添加并关联游戏**

1. 电脑和手机各自在“游戏”页添加游戏，点“选择存档目录”，选这部游戏存档所在的文件夹。
2. 在游戏设置的“关联设备”里先选设备，再选它上面对应的那部游戏。关联一次就行，改设备名或 IP 都不影响。

**同步存档**

1. 先退出游戏，游戏开着时存档可能正在被写入。
2. 在游戏菜单里选“传输存档”（电脑上是游戏面板里的“传输”），选好对端设备，确认来源和目标。方向反了就点“交换来源与目标”。
3. 点“下一步”，应用会列出这次要做的事：
   - **新建**：目标没有的文件。
   - **覆盖**：两端都有但内容不同的文件，点开可以对比两端的大小和修改时间。
   - **保留**：只在目标有的文件，默认不动。要让目标和来源完全一致，把“保留”切到“删除”。
4. 点“开始传输”。

也可以在电脑上发起传输，这时手机要开着应用并保持连接。传输结束后，任务页会显示结果：

| 结果 | 意思 | 怎么办 |
| --- | --- | --- |
| 传输完成 | 全部文件已写入并核对过 | - |
| 部分完成 | 前面的文件已写入，后面的出错或没执行 | 处理出错原因后重新传输，或从备份恢复 |
| 传输已取消 | 取消前已写入的文件会保留 | 需要的话从备份恢复 |
| 结果待确认 | 内容已发出，但没确认目标是否写好，常见于中途断网 | 点“重新扫描”查看目标当前的文件 |
| 上次写入被中断 | 写入时应用被关闭，文件可能不完整 | 从备份恢复 |

**备份与恢复**

写入前备份默认开启，每个游戏保留 3 份，可以在游戏的“备份与恢复”里关闭或改“保留份数”（最多 10 份），超出时自动删除最旧的。

要恢复时，在“备份与恢复”里选一份备份，点“恢复”，确认要改动的文件后才写入。恢复前会把当前文件再备份一份，恢复本身也可以撤回。

备份的位置：电脑上点“备份与恢复”页的“打开文件夹”；手机上在 `Android/data/io.github.galgame.savedatasync/files/backups/`，**卸载应用或清除应用数据会删除这些备份**。每份备份是一个以时间命名的文件夹，可以直接复制出来或删除；被手动删掉文件的备份会显示为“不完整”，不能用来恢复。

**Android 直接读写文件**

在“设置”里打开“直接读写文件”，再在系统页面允许“所有文件访问权限”，***扫描、备份和写入会快很多，存档文件多时差别明显***。不开也能正常使用，应用会通过选择目录时的系统授权读写。

`Android/data` 和 `Android/obb` 里的目录选不了，Android 不允许其他应用访问那里。

## 常见问题

**手机找不到电脑。** 确认电脑的本机服务在运行、两台设备连的是同一个网络。部分路由器的访客网络或“AP 隔离”会阻止设备互相访问，可以换主网络，或让手机连电脑开的移动热点。防火墙拦截时手机也搜不到，可以改用扫码或手动输入地址连接。

**提示版本不同。** 两台设备更新到同一个版本。

**提示存档目录已失效。** 目录被移动、改名，或者授权被收回了，到游戏设置里重新选择目录。

**提示超出单次传输限制。** 一次最多传 1024 个文件、单个文件最大 256 MiB、合计最大 1 GiB；写入前备份也按同样的上限计算目标目录。

**提示空间不足。** 写入需要的空间包括新文件和写入前备份。清理设备空间，或删除旧备份后再试。

**通信安全吗？** 存档只在你的两台设备之间传输，不上传到任何服务器。但设备之间的通信**没有加密，也没有配对密码**，同一网络里的其他设备也能访问电脑的本机服务。请只在家里等你信任的网络里使用，用完可以在电脑上停止本机服务。

## 从源码构建

需要 Node.js 22.13+ 和 pnpm 10.34.8；构建 Android 还需要 JDK 21 和 Android SDK。

```bash
git clone https://github.com/Lambholl/galgame-savedata-sync.git
cd galgame-savedata-sync
pnpm install
pnpm doctor                     # 检查开发工具是否齐全
pnpm desktop:package            # Windows 免安装版
pnpm android:build              # Android debug APK
```

Windows 产物在 `apps/desktop/release/`，APK 在 `apps/mobile/android/app/build/outputs/apk/`。开发、测试、签名和发布见[开发指南](docs/development.md)。

## 许可证

本项目采用 [GNU AGPL v3.0](LICENSE) 许可。
