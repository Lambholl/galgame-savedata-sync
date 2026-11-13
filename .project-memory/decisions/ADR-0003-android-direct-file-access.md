---
doc_type: adr
status: accepted
updated: 2026-11-14
tags: [决策, Android, 文件访问, SAF, 所有文件访问权限]
related_files: [apps/mobile/android/app/src/main/AndroidManifest.xml, apps/mobile/android/variables.gradle, apps/mobile/android/app/src/main/java/io/github/galgame/savedatasync]
---

# ADR-0003 Android 所有文件访问权限与统一的文件访问接口

## 目录

- [状态](#状态)
- [替代关系](#替代关系)
- [背景](#背景)
- [决策](#决策)
- [原因](#原因)
- [影响](#影响)
  - [正面影响](#正面影响)
  - [负面影响](#负面影响)
- [替代方案](#替代方案)
- [相关文件](#相关文件)

## 状态

accepted。

## 替代关系

| 被替代 ADR | 原路径 | 原因 |
| --- | --- | --- |
| 无 | 无 | 新决策；修订最低 Android 版本（REQ-001、项目约束“平台”） |

## 背景

经 SAF 每打开一个文件约 29 ms。一层 503 个文件、97 MiB 的存档目录，同时打开 8 个文件后比较仍要 7～8 秒，备份要 4～6 秒；同一目录 shell `cp -r` 约 0.4 秒。系统存储提供者（`com.android.externalstorage.documents`）的目录就是共享存储里的普通文件，有“所有文件访问权限”（`MANAGE_EXTERNAL_STORAGE`，Android 11 起）时可以直接按路径读写。应用不上 Google Play，只发 APK，所以不受 Play 对这项权限的审核限制。

## 决策

1. 最低版本升到 Android 11 / API 30，删掉只为 Android 10 写的代码。
2. manifest 声明 `MANAGE_EXTERNAL_STORAGE`，不另做构建变体。申请入口：设置页“直接读写文件”开关显示当前是否已授权，点按跳到系统的授权页；第一次添加游戏后提示一次，可选择不再提示。没有授权时一切照常走 SAF。
3. 目录仍用系统选择器选择并保存持久 SAF 授权；根目录是否有效、是否有写权限仍按 SAF 授权判断。
4. 目录访问抽象成一个接口 `DocumentAccess`，按（树 URI，文档 ID）查询属性、列出子项、打开读流和读写描述符、新建、删除、查询可用容量。`SafDocumentAccess`（ContentResolver）和 `FileDocumentAccess`（按路径读写）都实现它，返回同样的文档 ID、名称、类型、大小、修改时间和能力标志，ID 格式与系统存储提供者相同（`卷 ID:相对路径`）。目录登记、扫描、备份、打包、写入、新文件发布和本机恢复只调用这个接口。
5. 每次操作按开关取实现：已授权、目录属于系统存储提供者、卷能换算出实际路径时用 `FileDocumentAccess`，否则用 `SafDocumentAccess`。判断只看权限和目录归属，不看某个文件当时能不能读，所以一个任务进行中不会换路；直接读写失败时按现有错误码报错，不改走 SAF 重试。系统收回这项权限时是否结束应用进程待真机确认。
6. 两条路覆盖已有文件的方式相同：以 rw 打开同一文件、核对设备号和 inode 后从头写入，再截断到新长度。写到一半被结束时文件新旧混合，靠写入前备份恢复，和原来的 SAF 写入一样。
7. 界面只在设置页显示权限状态，游戏页和传输页不显示某个目录走哪条路。
8. `Android/data`、`Android/obb` 不在范围内：Android 11 起所有文件访问权限也进不去，系统选择器也选不了。

## 原因

- 两种实现共用一个接口和同一种 ID 格式，扫描结果、确认计划和条目引用在两条路之间通用，切换开关不用重新扫描或改动上层代码。
- 继续用系统选择器，不必新做文件浏览页；权限撤销后已配置的目录仍可用。
- 两条路原地覆盖，写入代码只有一份，行为一致；不会在存档目录留下临时文件，也不用清理。

## 影响

### 正面影响

- 本机存储上的目录扫描、备份、写入、恢复和打包不再受 SAF 每次打开文件的开销限制。

### 负面影响

- 放弃 Android 10。
- 覆盖中断后文件新旧混合的风险仍在，两条路相同。
- SD 卡等可移动存储在直接读写下能否写入取决于系统，待真机确认；不行时那类目录走 SAF。

## 替代方案

| 方案 | 优点 | 缺点 | 结果 |
| --- | --- | --- | --- |
| 授权后改用应用内文件浏览器选目录 | 能选系统选择器不让选的目录 | 要新做浏览页；撤销权限后目录全部失效 | rejected |
| Android 10 用 requestLegacyExternalStorage 加读写存储权限 | 保留 Android 10 | 多一套权限分支，Android 10 不在回归范围 | rejected |
| 每个任务开始时固定实现，任务内持有 | 语义直观 | 要在扫描、写入、传输、备份各处传递实现；权限收回本来就会结束进程，效果相同 | rejected |
| 直接读写先写同目录临时文件再改名替换 | 单个文件不会新旧混合 | 两条路行为不同；进程被结束会在存档目录留下临时文件，要额外清理并在扫描里排除 | rejected |

## 相关文件

| 文件 | 说明 |
| --- | --- |
| `apps/mobile/android/app/src/main/java/io/github/galgame/savedatasync/DocumentAccess.java` | 统一接口 |
| `SafDocumentAccess.java`、`FileDocumentAccess.java` | 两种实现 |
| `DirectoryStore.java`、`DirectorySyncBackend.java`、`DirectoryPublicationBackend.java`、`DirectorySyncSource.java`、`DirectoryArchiveSource.java` | 只调用接口的上层 |
| `AllFilesAccessPlugin.java`、移动端设置页 | 权限状态与申请入口 |
