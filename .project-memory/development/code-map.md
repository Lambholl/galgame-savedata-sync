---
doc_type: code-map
status: active
priority: medium
owner: development
updated: 2026-10-28
tags: [代码地图]
related_files: []
---

# 代码地图

| 路径 | 作用 | 重要约定 |
| --- | --- | --- |
| `package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml` | pnpm 工作区、固定版本与工程入口 | 私有工作区；使用指定 pnpm，不依赖系统全局 Gradle |
| `apps/desktop/` | Electron 主进程、preload 和独立 antd 界面 | Renderer 无 Node 集成；contextIsolation 和 sandbox 开启 |
| `apps/desktop/src/main/directory-adapter.ts`、`directory-store.ts`、`directory-paths.ts`、`directory-errors.ts` | 目录选择登记、独立配置、当前层元数据、根内原生读流及脱敏错误 | 没有源目录写入 API；拒绝 symlink/junction 与失效身份，配置不保存历史文件索引 |
| `apps/desktop/src/main/archive-adapter.ts`、`archive-cache.ts`、`archive-format.ts`、`archive-errors.ts` | 私有源快照、受限 USTAR/gzip1 编解码、逐层校验、资源/取消与缓存所有权/清理 | 无 HTTP 或目标发布；缓存与源根互不包含；句柄持有缓存，读流关闭后 dispose；清理失败阻止新任务 |
| `apps/desktop/test/archive-adapter.test.mjs`、`test/fixtures/archive-v1.json` | Windows 私有归档的格式、资源与故障回归，以及独立格式夹具 | 合成数据，不操作真实存档；Java 复用固定字节与原文期望；各自自我往返不算互通证据 |
| `apps/desktop/src/main/new-file-publisher.ts`、`publication-errors.ts`、`test/new-file-publisher.test.mjs` | 进程内写授权/预检、单文件候选/link/最终回读、逐项结果与清理重试 | 仅原生调用，目录/HTTP/UI 不自动授予写权限；候选与目标同卷，不覆盖/删除已有条目；崩溃后不猜测候选所有权 |
| `apps/desktop/src/main/http-service.ts`、`http-wire.ts`、`http-errors.ts`、`transfer-registry.ts` | 原生 HTTP 读取/接收、严格协议字节边界、会话内双角色任务/查询/取消、期限与单次 ID/content | 显式监听且默认回环；进程仅一活动批次，清理失败不释放；sender sent 与目标发布分开，目标结果看 receiver；应用退出等待 stop |
| `apps/desktop/src/main/upload-receiver.ts`、`test/http-receiver.test.mjs` | 单次上传背压/断流/取消、压缩体检查点与异步完整归档校验、顺序发布/部分结果与上下文核对 | 接收适配与本机写授权分开，全部原文验证前零发布；202 时发布结果另行查询；清理失败保留名额，响应/结果丢失不重放 |
| `apps/desktop/test/http-service.test.mjs` | 真实回环 HTTP/TCP、异步结果、单次领取、期限与清理回归 | 独立临时夹具；Android、LAN 和最终界面另做验收 |
| `apps/desktop/src/bridge/directory-bridge.ts`、`src/main/directory-ipc.ts`、`src/preload/index.ts` | 三个有限目录方法与 IPC 来源/参数/返回校验 | 绝对路径和文件内容不跨桥；handler 在退出时移除；main/preload 内联共享包 |
| `apps/desktop/src/bridge/service-bridge.ts`、`src/main/service-ipc.ts`、`src/renderer/src/features/transfer` | 本机服务启停/接收根授权/任务桥与目录、结果界面 | 系统选择及本机确认后授权，校验来源与 DTO；不传私有路径/字节；会话任务到期语义不变 |
| `apps/desktop/test/`、`apps/desktop/README.md` | Windows 目录、归档、HTTP 与发布的最小长期回归及接口说明 | pnpm check 不含 pnpm test:desktop；真实目录仅只读验证，机器路径不提交 |
| `apps/mobile/src/app`、`features`、`components`、`styles` | 独立移动入口、导航、游戏卡片、底部弹层和 antd-mobile 页面 | 优先移动组件；使用桌面组件也保留触控区域，操作卡片至少 64px；系统返回由移动端协调 |
| `apps/mobile/src/features/transfer`、`src/platform` | 双端目录、手动连接、文件/方向/目标映射和原生任务显示 | 仅当前层浏览；两列独立滚动、整行选择和分钟时间；后台停止网页轮询，重载查询同一原生任务；源文件内容不经过网页 |
| `apps/desktop/src/renderer/src/app`、`features`、`components`、`styles`、`platform` | 独立桌面导航、居中弹窗、antd 页面及有限桥接入 | 两端源码互不导入；桌面接收与服务能力保持，传输仍由手机发起 |
| `apps/mobile/android/` | Capacitor 生成的原生工程与项目 Wrapper | minSdk 29、compile/target 36；Manifest 明文 HTTP；包含用户发起传输使用的 dataSync 前台服务 |
| `apps/mobile/android/app/src/main/java/io/github/galgame/savedatasync/` | Java SAF 只读选择、权限/配置恢复、当前层元数据和原生流 | URI 留原生层，READ 持久授权，原生流调用者负责关闭；配置不保存条目或哈希 |
| 同目录 `ArchiveAdapter.java`、`ArchiveModel.java`、`ArchiveFormat.java`、`ArchiveCache.java`、`ArchiveControl.java`、`ArchiveFailure.java`、`SafArchiveSource.java` | Java 私有源快照、严格 USTAR/单 gzip、固定预算/取消/期限与缓存归属/恢复/重试；SAF 读取后复核 | 无 JSON/HTTP/目标发布或文件内容跨桥；句柄关闭读流后 close；进程独占覆盖待清理资源 |
| `apps/mobile/android/app/src/test/java/io/github/galgame/savedatasync/ArchiveAdapterTest.java`、`src/androidTest/java/io/github/galgame/savedatasync/ArchiveSafTest.java` | Java 归档格式/资源回归及实际设备 SAF 快照 | 共用独立夹具，Windows/JVM/Android 压缩器互通；合成源只读，缺少实际目录授权失败而非跳过 |
| 同 Java 目录 `NewFilePublisher.java`、`PublicationModel.java`、`PublicationJson.java`、`SafPublicationBackend.java` | 原生显式写授权/只读预检、创建前后核实、非截断写入/回读、单文件结果及清理重试 | 只操作同根已有父目录中的确知新建条目；常规描述符身份保护已有文件；原文/URI 不跨桥，清理失败保持进程名额；接口见移动 README |
| `NewFilePublisherTest.java`、实际 SAF 发布验收记录 | 发布故障回归与原生日志/结果核对 | 独立命名夹具、控制文件前后保护、归档读流/冲突/取消/清理重试；设备授权只用于合成目标 |
| 同 Java 目录 `TransferJson/Schema/Http/Engine.java`、`HttpTransfersPlugin.java`、`TransferRuntime/Service.java`、`SafRuntime.java` | 严格 HTTP/JSON、双向原生编排及应用级任务、持续通知和 Activity 重连 | 文件不跨 JS；用户发起后后台继续，完整校验后逐项发布；服务不导出、不自动重启旧任务；只读桥和传输共享当前 SAF 引用 |
| `apps/mobile/src/platform/http-transfer-bridge.ts`、`http-transfers.ts` | 有限 TS 任务桥与 native 当前上下文/角色/结果校验、顺序事件订阅 | 浏览器不支持；通知/目标授权为显式动作，任务/清单仅存本进程；订阅 remove 不取消传输 |
| `scripts/verify-archive-interop.mjs` | 构建前 Windows 准备、构建后 Windows 接收 Java 输出，另支持设备产物及 SAF 原文验证 | prepare/verify 纳入 android:test；只操作固定报告目录中的合成数据，测试 APK 不包含主机路径配置 |
| `apps/mobile/src/platform/saf-directory-bridge.ts`、`saf-directories.ts`、`test/`、`README.md` | 受限 TS 桥、原生绑定、数据模型检查与调用说明 | 网页预览不支持；只传公开 DTO/ID，无内容/写入方法；pnpm check 不含 pnpm test:mobile |
| `apps/mobile/android/app/src/test/`、`src/androidTest/` | Java 纯边界与 3 条设备路径：SAF 读取、归档互通、实际 SAF 快照 | 独立私有夹具与真实选择器授权；真实源只读 |
| `apps/shared/src/index.ts`、`library/game-links.ts`、`transfer`、`result.ts` | 应用名、共享模型、游戏关联、传输预检和任务判断导出入口 | 纯 TypeScript；界面、Hook、存储、文件与网络操作留在各端 |
| `apps/shared/src/sync/` | 本次扫描/计划/备份/结果 DTO、路径关系、纯比较及上下文重算守卫 | 独立 schema 1，不改批量 v1；不做 IO、哈希计算或历史查询；复制方向显式，本机恢复强制保护当前内容 |
| `apps/shared/src/protocol/contracts.ts`、`protocol.ts`、`validation.ts` | 协议版本 1 DTO、错误/路由/头名映射与纯数据守卫 | 目录不汇总大小；封闭 DTO 区分空值/失败/未知结果；平台路径、权限和真实内容校验仍由适配器负责 |
| `apps/shared/src/protocol/batch-contracts.ts`、`batch-limits.ts`、`batch-validation.ts`、`batch-context.ts`、`data-validation.ts` | v1 批量 DTO、固定预算/期限、结构/关系守卫与任务上下文匹配；基础容器/文本/数值辅助供内部复用 | sender/receiver 分开；清单与目标一一对应；matchesBatchState 核对实际结果；无归档、HTTP、IO 或历史存储 |
| `apps/shared/test/`、`apps/shared/README.md` | 运行时数据关系回归、完整线格式与调用示例 | pnpm test:shared 单独运行，类型约束由 tsc 检查；pnpm check 不运行这两项 |
| `scripts/doctor.mjs`、`scripts/local-environment.mjs` | 开发工具入口 | 使用方式见 README |
| `scripts/android-build.mjs`、`scripts/android-open.mjs` | 原生构建、单元/lint/双 APK 检查、依赖清单与 IDE 入口 | pnpm android:test 不连接设备；只对子进程传入 SDK/JDK；IDE 不存在时明确失败 |
| `scripts/check-text.mjs`、`eslint.config.mjs`、`tsconfig.base.json` | 编码、格式、lint 和严格类型检查 | 生成目录不作为手写代码格式化 |
| `scripts/security-check.mjs`、`scripts/toolchain-policy.mjs` | npm 全量审计、pnpm 公告与 Node 安全补丁门禁 | 查询失败即失败；安全基线来自已核实的官方发行记录 |
| `scripts/android-inventory.gradle`、`scripts/security-android.mjs` | 解析 Maven 实际依赖并查询 OSV | 含运行、测试和构建图；未解析依赖导致失败；临时报告在 .reports/ |
| `.github/workflows/ci.yml` | Windows 工程检查与 Android 构建 CI | Action 固定 commit SHA；日常 push/PR 执行 pnpm check 与 android:build，安全审计通过原命令手动运行；远端结果见 testing/regression-notes.md |
| `README.md`、`docs/development.md` | 开发命令、工具要求与检查范围 | 版本约束以工程配置为准 |
