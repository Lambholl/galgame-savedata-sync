---
doc_type: implementation-notes
status: active
priority: medium
owner: development
updated: 2026-10-26
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
| 基础设施 | pnpm 工作区、双端 React 空壳、共享入口、严格 TS / ESLint / Prettier、编码检查和 Windows CI 已建立 | 根目录配置、apps/、packages/shared、scripts/、.github/workflows/ci.yml |
| 双端明暗主题 | 桌面用系统媒体查询与 React 订阅切换 antd 算法，原生窗口底色同步并在关闭时释放监听；移动端在挂载前设置 antd-mobile 官方主题属性，运行时同步，热更新释放监听；移动端暗色页面/启动/原生背景统一 #000000，透明 WebView 配合；运行中接收原生 uiMode 通知修正 WebView 缓存的媒体查询，系统栏显式同步图标颜色；空状态说明使用语义文字色，无偏好持久化 | 双端 App/main/style、use-system-dark-mode.ts、system-theme.ts、桌面主进程、Android 主题/颜色资源、MainActivity |
| 共享本地/批量模型 | 数字 v1 同时提供本地设备/目录 DTO 与批量传输模型；批量清单/映射/状态/结果、路由/头/错误/预算常量、封闭守卫及上下文匹配已经可用。sender sent 与 receiver succeeded 分开，实际文件哈希/根/父/名需匹配本任务；共享层只校验数据，哈希计算留给平台 | packages/shared/src/contracts.ts、protocol.ts、validation.ts、batch-*.ts、data-validation.ts；packages/shared/README.md |
| 共享检查入口 | pnpm test:shared 运行最小稳定数据关系测试；类型约束由 tsc 检查。`pnpm check` 只做静态检查和构建。共享只用 ES2022、无自动平台类型、启用 erasableSyntaxOnly | package.json、tsconfig.base.json、packages/shared/tsconfig.json、packages/shared/test |
| Windows 目录读取 | schema 1 配置在应用 userData，保存稳定设备/根 ID 与 bigint dev/ino 身份；配置不位于所选根内，未知版本/坏配置不重置。条目映射仅存内存；支持当前层读取、身份重查及原生只读流 | apps/desktop/src/main/directory-adapter.ts、directory-store.ts、directory-paths.ts；完整说明见 apps/desktop/README.md |
| Windows 私有归档 | 源原文按流建立快照并计算长度/SHA-256，读取后检查身份/大小/mtime/ctime，再按规范 USTAR/gzip1 打包及完整解包；gzip 用原始 DEFLATE 消耗量加 CRC32/ISIZE 与 tar 精确结束检查，拒绝拼接/尾随，逐文件校验后才返回句柄 | apps/desktop/src/main/archive-*.ts；apps/desktop/README.md；docs/plans/m001-tar-gzip-protocol.md |
| 私有缓存与取消 | 固定应用私有缓存根和随机任务目录带所有权标记，拒绝与所选源根重叠；一份活动缓存覆盖返回句柄生命周期；显式缓冲不超过 64 KiB，预算可本机收紧，实际写入前计数/空间检查；失败/取消只清理本次缓存，清理失败独立报告并阻止新任务，关闭读流后重试；无源/目标发布写入 | archive-cache.ts、archive-errors.ts；仅内部句柄，不经 IPC；孤儿缓存不恢复历史任务 |
| Windows HTTP sender | Node 内置 HTTP；只处理登记根、异步准备/清单/单次 gzip、状态与取消；严格 JSON 键/UTF-8/字节及路由/头/会话；注册前同步占用 ID/进程名额；期限和清理失败独立处理；保留有限 ID 防重，重启更换会话 | apps/desktop/src/main/http-*.ts、transfer-registry.ts、test/http-service.test.mjs |
| Windows HTTP receiver | POST 异步全目标预检，物理父目录/名称去重后 201；PUT 唯一领取，64 KiB 背压桥显式终止停滞等待；压缩体落盘/长度/SHA-256 通过后 202，完整 gzip/tar/原文校验后才顺序发布；部分结果/清理分开，最后提交可赢得取消竞争；输入完整后响应丢失不终止本机发布 | upload-receiver.ts、transfer-registry.ts、archive-adapter.ts、test/http-receiver.test.mjs |
| 服务启停与退出 | 构造时不监听，可信主进程显式 start，默认回环/动态端口；应用 before-quit 等待 stop，失败保留清理重试；UI/控制 IPC 留后续包；真实回环覆盖本机服务，LAN/Android 另行验证 | apps/desktop/src/main/index.ts；apps/desktop/README.md |
| Windows 新文件发布 | 进程内显式根写授权与只读目标预检；同父目录 wx 候选逐块实测长度/哈希并 sync；link 排他发布后回读最终身份/EOF/SHA-256；成功/取消/unknown 与清理状态分开；仅删除身份匹配的自有候选，清理失败占名额至重试成功 | new-file-publisher.ts、publication-errors.ts；目录 locateNativeDirectory 只读 |
| 发布恢复与平台边界 | 不支持安全 link 的文件系统失败关闭；候选所有权/写授权仅存本进程，正常退出等待停止，强杀后不猜测或自动删除目标卷候选；不恢复旧任务，跨进程恢复/其他卷/特殊名称等价未验收 | apps/desktop/README.md；testing/coverage-gaps.md |
| 有限 Electron 桥 | 只暴露 chooseDirectory/listRoots/listDirectory；主窗口、主 frame、精确 URL 和参数/返回 DTO 均校验；无任意路径、内容、写入或删除入口。workspace 共享包在 main/preload 构建内联，preload 仅需 Electron require | apps/desktop/src/directory-bridge.ts、src/main/directory-ipc.ts、src/preload/index.ts、electron.vite.config.ts |
| Windows 检查 | pnpm test:desktop 的最小回归覆盖目录/IPC、归档、HTTP 和发布；不纳入 pnpm check。夹具统一采用异步 realpath 临时根；既有真实存档只读检查内容与 mtime 一致，具体路径/哈希不保存 | apps/desktop/test；testing/regression-notes.md |
| Java SAF 读取 | 提供只读系统选择器、稳定根/设备 ID 与权限恢复、当前层元数据和原生 InputStream；URI 不出原生层，不保存历史条目/哈希；API 33 合成夹具与旧 API 35 真实目录分别通过读取、选择/取消及重启恢复；首次访问 ctime 的未确定归因见回归状态 | apps/mobile/README.md、apps/mobile/src/saf-*、Android Java 源码及测试 |
| Java 私有归档 | 从实际流建立原文快照，统计未知长度并在读取后复核 SAF 观察值，再生成规范 USTAR/gzip1；显式原始 inflater 消耗边界及 CRC/ISIZE/物理 EOF，全部逐文件 SHA 和精确 tar 结束通过才返回句柄。固定 v1 原生不可变模型不承担网络 JSON 解码 | ArchiveAdapter.java、ArchiveModel.java、ArchiveFormat.java、SafArchiveSource.java；apps/mobile/README.md |
| Java 缓存及验证 | 可信 Context 先解析系统私有路径别名；其下缓存标记/随机任务/链接及未知条目失败关闭；进程任务独占直到句柄释放或清理成功，主错误/清理错误分开，可重试和启动孤儿恢复；64 KiB 实际流预算，取消关闭源/查询。JVM、API 33 设备和双向原生互通验证通过，源原文经外部独立复核 | ArchiveCache.java、ArchiveControl.java、ArchiveFailure.java、ArchiveAdapterTest.java、ArchiveSafTest.java、scripts/verify-archive-interop.mjs |
| Java SAF 单文件发布 | 系统 WRITE 与本次进程 grant 分开；preflight 无写入；创建前后枚举/名称等价/新 ID/父目录核实，提供者改名停止；保持空新文件 FD 身份，以 rw 不截断打开并再次核实设备/inode/零长度；64 KiB 计数/SHA 写流，关闭同步后完整回读、EOF、身份/名称/元数据前后检查后成功 | NewFilePublisher.java、SafPublicationBackend.java、PublicationModel.java；apps/mobile/README.md |
| Java 发布结果与清理 | 原生 PublicationJson 对齐共享 FileOutcome/BatchCleanup，错误脱敏、unknown 不自动重放；失败/取消仅清理确知新建且身份匹配条目，关闭流/删除失败保留资源与进程名额至 retryCleanup；已确认成功不因晚取消或关闭失败删除；归档和发布名额独立，后续 HTTP 只编排 | PublicationJson.java、NewFilePublisherTest.java；TC-008 |
| Android 原生 HTTP/通知 | TransferJson 严格 UTF-8/重复键/安全整数及有界 JSON，TransferSchema 独立核对任务/清单/角色/结果；无代理/缓存/重定向/自动解压，64 KiB、固定长度/SHA、60 秒网络停滞及 30 分钟总期限；丢失 POST/PUT 回执只查询。应用级 Runtime 持有任务，dataSync 服务持续通知保持传输；Activity 暂停或销毁不取消，完成/显式取消与清理后停止 | Transfer*.java、HttpTransfersPlugin、SafRuntime、TS 桥；移动 README/TC-035 |
| 当前产品状态 | 已有空壳、本地/批量共享模型、双端读取适配、双端私有归档、Windows HTTP sender/receiver 与批次非覆盖发布；Android SAF 单文件发布及 HTTP/通知保持传输已经可用；项目管理、mDNS 和同步算法还没实现，最终界面留 WP-007 | apps/desktop、apps/mobile、development/work-packages.md |
| 固定依赖 | 采用兼容的 React 18 / TypeScript 5.9；pnpm 10.34.8；精确锁定版本和 lockfile，保留严格 peer 检查 | package.json、pnpm-lock.yaml、pnpm-workspace.yaml |
| npm 安全 | 官方 registry 对 397 项依赖复审零已知漏洞；xcode 的 uuid 定向修复为 11.1.1，已验证 CommonJS UUID 调用兼容；pnpm 独立 OSV 查询零公告 | scripts/security-check.mjs、pnpm-workspace.yaml |
| Gradle 安全 | 升级为 8.14.6；分发 ZIP 固定官方 SHA-256，Wrapper JAR 已按官方 SHA-256 验证并更新启动器 | apps/mobile/android/gradle/wrapper/、gradlew、gradlew.bat |
| Android 工具依赖 | AGP 8.13.2 与统一补丁策略已生效；全部可解析 Maven 配置（含各变体、测试、lint 和构建工具）与 Gradle Core 共 273 项复审零已知公告；包含 Protobuf 3.x 修复且保留 4.x 请求。移除未使用的 Google Services 构建插件 | apps/mobile/android/dependency-security.json、scripts/security-android.mjs |
| Android 原生检查 | Java 单元、lint、双 APK、原生归档互通及移动桥检查通过；默认不新增或扩写自动化测试。实际 API 33 正式 LAN 双向、后台传输、持续通知、Activity 重连、显式取消与外部原文/属性保护通过 | Java 既有检查、ADB 实操与截图；testing/regression-notes.md |

## 2. 维护说明

| 事项 | 原因 | 影响 |
| --- | --- | --- |
| 依赖策略维护 | Android 模板默认构建依赖可能落后于安全补丁；npm audit 不覆盖 Maven 或包管理器 | 持续运行 security:check 与 security:android，升级策略后必须复审实际图并构建 |
