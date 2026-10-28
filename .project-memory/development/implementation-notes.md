---
doc_type: implementation-notes
status: active
priority: medium
owner: development
updated: 2026-10-28
tags: [实现细节]
related_files: []
---

# 实现细节

## 目录

- [1. 当前结论](#1-当前结论)
- [2. 维护说明](#2-维护说明)

## 1. 当前结论

| 主题 | 结论 | 相关文件 |
| --- | --- | --- |
| 基础设施 | pnpm 工作区、双端 React 应用、共享入口、严格 TS / ESLint / Prettier、编码检查和 Windows CI 已建立 | 根目录配置、apps/、apps/shared、scripts/、.github/workflows/ci.yml |
| 双端明暗主题 | 桌面用系统媒体查询与 React 订阅切换 antd 算法，原生窗口底色同步并在关闭时释放监听；移动端在挂载前设置 antd-mobile 官方主题属性，运行时同步，热更新释放监听；移动端暗色页面/启动/原生背景统一 #000000，透明 WebView 配合；运行中接收原生 uiMode 通知修正 WebView 缓存的媒体查询，系统栏显式同步图标颜色；空状态说明使用语义文字色，无偏好持久化 | 双端 app/main/styles、移动 system-theme.ts、桌面主进程、Android 主题/颜色资源、MainActivity |
| 共享本地/批量模型 | 数字 v1 同时提供本地设备/目录 DTO 与批量传输模型；批量清单/映射/状态/结果、路由/头/错误/预算常量、封闭守卫及上下文匹配已经可用。sender sent 与 receiver succeeded 分开，实际文件哈希/根/父/名需匹配本任务；共享层只校验数据，哈希计算留给平台 | apps/shared/src/protocol/contracts.ts、protocol.ts、validation.ts、batch-*.ts、data-validation.ts；apps/shared/README.md |
| 共享检查入口 | pnpm test:shared 运行最小稳定数据关系测试；类型约束由 tsc 检查。`pnpm check` 只做静态检查和构建。共享只用 ES2022、无自动平台类型、启用 erasableSyntaxOnly | package.json、tsconfig.base.json、apps/shared/tsconfig.json、apps/shared/test |
| Windows 目录读取 | schema 1 配置在应用 userData，保存稳定设备/根 ID 与 bigint dev/ino 身份；配置不位于所选根内，未知版本/坏配置不重置。条目映射仅存内存；支持当前层读取、身份重查及原生只读流 | apps/desktop/src/main/directory-adapter.ts、directory-store.ts、directory-paths.ts；完整说明见 apps/desktop/README.md |
| Windows 私有归档 | 源原文按流建立快照并计算长度/SHA-256，读取后检查身份/大小/mtime/ctime，再按规范 USTAR/gzip1 打包及完整解包；gzip 用原始 DEFLATE 消耗量加 CRC32/ISIZE 与 tar 精确结束检查，拒绝拼接/尾随，逐文件校验后才返回句柄 | apps/desktop/src/main/archive-*.ts；apps/desktop/README.md；docs/plans/m001-tar-gzip-protocol.md |
| 私有缓存与取消 | 固定应用私有缓存根和随机任务目录带所有权标记，拒绝与所选源根重叠；一份活动缓存覆盖返回句柄生命周期；显式缓冲不超过 64 KiB，预算可本机收紧，实际写入前计数/空间检查；失败/取消只清理本次缓存，清理失败独立报告并阻止新任务，关闭读流后重试；无源/目标发布写入 | archive-cache.ts、archive-errors.ts；仅内部句柄，不经 IPC；孤儿缓存不恢复历史任务 |
| Windows HTTP sender | Node 内置 HTTP；只处理登记根、异步准备/清单/单次 gzip、状态与取消；严格 JSON 键/UTF-8/字节及路由/头/会话；注册前同步占用 ID/进程名额；期限和清理失败独立处理；保留有限 ID 防重，重启更换会话 | apps/desktop/src/main/http-*.ts、transfer-registry.ts、test/http-service.test.mjs |
| Windows HTTP receiver | POST 异步全目标预检，物理父目录/名称去重后 201；PUT 唯一领取，64 KiB 背压桥显式终止停滞等待；压缩体落盘/长度/SHA-256 通过后 202，完整 gzip/tar/原文校验后才顺序发布；部分结果/清理分开，最后提交可赢得取消竞争；输入完整后响应丢失不终止本机发布 | upload-receiver.ts、transfer-registry.ts、archive-adapter.ts、test/http-receiver.test.mjs |
| 每次传输容量预检 | Windows 登记接收前检查缓存与整批目标，同卷合计峰值；Android 打开下载内容流前检查缓存及提供者可报告的目标容量，未知容量保留未知；实际写入继续检查，空间不足反馈 insufficient-space。满额双向、资源和 M-001 结论见 docs/validation/m001-resources.md | archive-adapter.ts、new-file-publisher.ts、transfer-registry.ts；ArchiveAdapter/Cache、NewFilePublisher、SafPublicationBackend、TransferEngine/Schema.java |
| 服务启停与退出 | 构造时不监听，可信主进程显式 start，默认回环/动态端口；应用 before-quit 等待 stop，失败保留清理重试；WP-007 有限 IPC 提供显式 LAN 启停、接收根授权/撤销、任务快照/取消及清理重试，界面轮询卸载时停止；真实回环覆盖本机服务，LAN/Android 另行验证 | apps/desktop/src/main/index.ts；apps/desktop/README.md |
| Windows 新文件发布 | 进程内显式根写授权与只读目标预检；同父目录 wx 候选逐块实测长度/哈希并 sync；link 排他发布后回读最终身份/EOF/SHA-256；成功/取消/unknown 与清理状态分开；仅删除身份匹配的自有候选，清理失败占名额至重试成功 | new-file-publisher.ts、publication-errors.ts；目录 locateNativeDirectory 只读 |
| 发布恢复与平台边界 | 不支持安全 link 的文件系统失败关闭；候选所有权/写授权仅存本进程，正常退出等待停止，强杀后不猜测或自动删除目标卷候选；不恢复旧任务，跨进程恢复/其他卷/特殊名称等价未验收 | apps/desktop/README.md；testing/coverage-gaps.md |
| 有限 Electron 桥 | 目录桥暴露 chooseDirectory/listRoots/listDirectory；独立服务桥提供 status/start/randomizePort/stop/chooseTarget/revokeTarget/cancel/retryCleanup；主窗口、主 frame、精确 URL 和参数/返回 DTO 均校验；系统选择目录后授予本进程写入权限，路径/内容由原生持有。workspace 共享包在 main/preload 构建内联，preload 仅需 Electron require | apps/desktop/src/bridge/directory-bridge.ts、src/bridge/service-bridge.ts、src/main/directory-ipc.ts、src/main/service-ipc.ts、src/preload/index.ts、electron.vite.config.ts |
| Windows 检查 | pnpm test:desktop 的最小回归覆盖目录/IPC、归档、HTTP 和发布；不纳入 pnpm check。夹具统一采用异步 realpath 临时根；既有真实存档只读检查内容与 mtime 一致，具体路径/哈希不保存 | apps/desktop/test；testing/regression-notes.md |
| Java SAF 读取 | 提供只读系统选择器、稳定根/设备 ID 与权限恢复、当前层元数据和原生 InputStream；URI 不出原生层，不保存历史条目/哈希；API 33 合成夹具与旧 API 35 真实目录分别通过读取、选择/取消及重启恢复；首次访问 ctime 的未确定归因见回归状态 | apps/mobile/README.md、apps/mobile/src/platform/saf-*、Android Java 源码及测试 |
| Java 私有归档 | 从实际流建立原文快照，统计未知长度并在读取后复核 SAF 观察值，再生成规范 USTAR/gzip1；显式原始 inflater 消耗边界及 CRC/ISIZE/物理 EOF，全部逐文件 SHA 和精确 tar 结束通过才返回句柄。固定 v1 原生不可变模型不承担网络 JSON 解码 | ArchiveAdapter.java、ArchiveModel.java、ArchiveFormat.java、SafArchiveSource.java；apps/mobile/README.md |
| Java 缓存及验证 | 可信 Context 先解析系统私有路径别名；其下缓存标记/随机任务/链接及未知条目失败关闭；进程任务独占直到句柄释放或清理成功，主错误/清理错误分开，可重试和启动孤儿恢复；64 KiB 实际流预算，取消关闭源/查询。JVM、API 33 设备和双向原生互通验证通过，源原文经外部独立复核 | ArchiveCache.java、ArchiveControl.java、ArchiveFailure.java、ArchiveAdapterTest.java、ArchiveSafTest.java、scripts/verify-archive-interop.mjs |
| Java SAF 单文件发布 | 系统 WRITE 与本次进程 grant 分开；preflight 无写入；创建前后枚举/名称等价/新 ID/父目录核实，提供者改名停止；保持空新文件 FD 身份，以 rw 不截断打开并再次核实设备/inode/零长度；64 KiB 计数/SHA 写流，关闭同步后完整回读、EOF、身份/名称/元数据前后检查后成功 | NewFilePublisher.java、SafPublicationBackend.java、PublicationModel.java；apps/mobile/README.md |
| Java 发布结果与清理 | 原生 PublicationJson 对齐共享 FileOutcome/BatchCleanup，错误脱敏、unknown 不自动重放；失败/取消仅清理确知新建且身份匹配条目，关闭流/删除失败保留资源与进程名额至 retryCleanup；已确认成功不因晚取消或关闭失败删除；归档和发布名额独立，后续 HTTP 只编排 | PublicationJson.java、NewFilePublisherTest.java；TC-008 |
| Android 原生 HTTP/通知 | TransferJson 严格 UTF-8/重复键/安全整数及有界 JSON，TransferSchema 独立核对任务/清单/角色/结果；无代理/缓存/重定向/自动解压，64 KiB、固定长度/SHA、连接和默认网络无进展等待 5 秒、初次握手总期限 5 秒及传输总期限 30 分钟；丢失 POST/PUT 回执只查询。应用级 Runtime 持有任务，dataSync 服务持续通知保持传输；Activity 暂停或销毁不取消，完成/显式取消与清理后停止 | Transfer*.java、HttpTransfersPlugin、SafRuntime、TS 桥；移动 README/TC-035 |
| 双端界面与恢复 | 两端独立页面和状态使用既有受限目录/传输桥；源文件显式选择，目标用已有父目录与单文件名映射，真实计数和 sender/receiver 分别显示；Android 不按前后台状态主动停止轮询，原生目录/HTTP/扫描不设置可见性门禁；重载从 current 查询同一原生任务；清单生成前取消/失败仍返回全项未尝试终态；系统提供的桌面 userData 先 realpath，再进行私有缓存检查 | apps/mobile/src/app、features、components、platform；apps/desktop/src/renderer/src、bridge、main；TransferEngine.java |
| 固定依赖 | 采用兼容的 React 18 / TypeScript 5.9；pnpm 10.34.8；精确锁定版本和 lockfile，保留严格 peer 检查 | package.json、pnpm-lock.yaml、pnpm-workspace.yaml |
| npm 安全 | 2026-10-25 审计的 397 项依赖与 pnpm OSV 结果为零公告；用户本次提供的 CI 日志报告 antd-mobile 间接依赖 deepmerge 的低危公告 GHSA-gcqx-w48m-w2h4，尚未处理。xcode 的 uuid 定向修复为 11.1.1，CommonJS UUID 调用兼容已验证 | scripts/security-check.mjs、pnpm-workspace.yaml；testing/regression-notes.md |
| Gradle 安全 | 升级为 8.14.6；分发 ZIP 固定官方 SHA-256，Wrapper JAR 已按官方 SHA-256 验证并更新启动器 | apps/mobile/android/gradle/wrapper/、gradlew、gradlew.bat |
| Android 工具依赖 | AGP 8.13.2 与统一补丁策略已生效；全部可解析 Maven 配置（含各变体、测试、lint 和构建工具）与 Gradle Core 共 273 项复审零已知公告；包含 Protobuf 3.x 修复且保留 4.x 请求。移除未使用的 Google Services 构建插件 | apps/mobile/android/dependency-security.json、scripts/security-android.mjs |
| Android 原生检查 | Java 单元、lint、双 APK、原生归档互通及移动桥检查通过；默认不新增或扩写自动化测试。实际 API 33 正式 LAN 双向、后台传输、持续通知、Activity 重连、显式取消与外部原文/属性保护通过 | Java 既有检查、ADB 实操与截图；testing/regression-notes.md |
| 连接状态与短时提示 | 元数据轮询兼作心跳；Windows 按通信期限判离线，Android 只将本次交换成功的设备标在线，空闲失联时释放连接，活动任务仍可查询。断连回到未连接，antd message 提示一次，不诊断原因；手机连接失败由 Toast 改为同一 message，跟随本端明暗主题 | 双端 App、移动 library-adapter/App、shared library 注释；受控失联与实际页面操作检查通过 |
| Windows 独立备份 | 在私有 backups 保存独立清单和原文，逐文件复核源、哈希/落盘/回读后提交；最近 3 次，恢复材料引用保护输入，轮换失败另报；不保存比较基线。独立设置缺省开启，坏设置保留；启动登记私有区以阻止选作同步根，未提交/淘汰残留仅显式清理 | backup-store/files/ipc、backup-bridge、directory-adapter、启动/preload；实际文件和新进程重启、故障/取消/容量/清理及有限桥验证通过 |
| Windows 受保护写入与恢复 | 先重扫目标和核对全部输入，预检同卷峰值，完整备份后按计划创建目录和逐文件发布；同卷候选 fsync/回读，覆盖前再核对旧内容和身份，最终回读后才成功。本机恢复引用输入且强制保护当前文件；候选清理失败保持与旧批次共用的互斥 | sync-writer、sync-target-files、target-operation、directory-adapter、transfer-registry、启动；实际合成目录覆盖/恢复/保留/占用失败、取消/超时/部分/未知结果、容量/故障/残留归属和既有桌面回归通过 |
| Android 独立备份 | 复用 SAF 读取，应用私有 files/backups 保存与共享 v1 一致的独立清单和原文；全部旧内容落盘及回读后提交，三轮保留及恢复引用保护，独立设置/容量和明确清理。Native 插件仅设置/摘要/单轮清单，创建与文件流交原生编排 | BackupStore/Model/Files、AndroidBackupIo、SyncBackupsPlugin、TS backup bridge；API 33 实际 SAF/原文独立哈希/源属性/进程重启、JVM 故障及桥检查通过；安卓实测使用 API 33 设备 |

## 2. 维护说明

| 事项 | 原因 | 影响 |
| --- | --- | --- |
| 依赖策略维护 | Android 模板默认构建依赖可能落后于安全补丁；npm audit 不覆盖 Maven 或包管理器 | security:check 与 security:android 保留为手动审计命令，日常 push/PR CI 只执行工程检查和 Android 构建；依赖升级后复审实际图并构建 |
