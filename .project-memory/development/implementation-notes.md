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
- [2. 注意事项](#2-注意事项)

## 1. 当前结论

| 主题 | 结论 | 相关文件 |
| --- | --- | --- |
| 基础设施 | pnpm 工作区、双端 React 空壳、共享入口、严格 TS / ESLint / Prettier、编码检查和 Windows CI 已建立 | 根目录配置、apps/、packages/shared、scripts/、.github/workflows/ci.yml |
| 共享本地/批量契约 | 数字 v1 同时提供本地设备/目录 DTO 与批量传输模型；批量清单/映射/状态/结果、路由/头/错误/预算常量、封闭守卫及上下文匹配已实现。sender sent 与 receiver succeeded 分开，实际文件哈希/根/父/名需匹配本任务；无平台 IO，不计算实际哈希 | packages/shared/src/contracts.ts、protocol.ts、validation.ts、batch-*.ts、data-validation.ts；packages/shared/README.md |
| 共享检查入口 | pnpm test:shared 的 32 项运行时测试（12 项基础、20 项批量/上下文）、16 项类型反例及 pnpm check 通过；包含全部原有目录桥和双端构建。共享只用 ES2022、无自动平台类型、启用 erasableSyntaxOnly；未新增依赖 | package.json、tsconfig.base.json、packages/shared/tsconfig.json、packages/shared/test |
| Windows 目录读取 | schema 1 配置在应用 userData，保存稳定设备/根 ID 与 bigint dev/ino 身份；配置不位于所选根内，未知版本/坏配置不重置。条目映射仅存内存；当前层读取、身份重查及原生只读流已实现 | apps/desktop/src/main/directory-adapter.ts、directory-store.ts、directory-paths.ts；完整说明见 apps/desktop/README.md |
| Windows 私有归档 | 已实现源原文流式快照/长度/SHA-256、读取后身份/大小/mtime/ctime 检查、规范 USTAR/gzip1 打包及完整解包；gzip 用原始 DEFLATE 消耗量加 CRC32/ISIZE 与 tar 精确结束检查，拒绝拼接/尾随，逐文件校验后才返回句柄 | apps/desktop/src/main/archive-*.ts；apps/desktop/README.md；docs/plans/m001-tar-gzip-protocol.md |
| 私有缓存与取消 | 固定应用私有缓存根和随机任务目录带所有权标记，拒绝与所选源根重叠；一份活动缓存覆盖返回句柄生命周期；显式缓冲不超过 64 KiB，预算可本机收紧，实际写入前计数/空间检查；失败/取消只清理本次缓存，清理失败独立报告并阻止新任务，关闭读流后重试；无源/目标发布写入 | archive-cache.ts、archive-errors.ts；仅内部句柄，不经 IPC；孤儿缓存不恢复历史任务 |
| 有限 Electron 桥 | 只暴露 chooseDirectory/listRoots/listDirectory；主窗口、主 frame、精确 URL 和参数/返回 DTO 均校验；无任意路径、内容、写入或删除入口。workspace 共享包在 main/preload 构建内联，preload 仅需 Electron require | apps/desktop/src/directory-bridge.ts、src/main/directory-ipc.ts、src/preload/index.ts、electron.vite.config.ts |
| Windows 检查 | pnpm test:desktop 的 36 项测试（16 目录/IPC、20 私有归档）与 pnpm check 通过；夹具统一采用异步 realpath 临时根；Windows 8.3 短路径子进程回归通过且无跳过，远端复验见回归状态。既有真实存档只读检查内容与 mtime 一致，具体路径/哈希不保存 | apps/desktop/test；testing/regression-notes.md |
| Java SAF 读取 | 已实现只读系统选择器、稳定根/设备 ID 与权限恢复、当前层元数据和原生 InputStream；URI 不出原生层，未保存历史条目/哈希；API 33 合成夹具与旧 API 35 真实目录分别通过读取、选择/取消及重启恢复；首次访问 ctime 的未确定归因见回归状态 | apps/mobile/README.md、apps/mobile/src/saf-*、Android Java 源码及测试 |
| 独立传输基准 | 仅 debug 的精确目录授权 Activity 与手动仪器用例，配合 Python 标准库私有 HTTP 对端；三样本双向比较实验共 54 组通过，含 SAF 写后回读，作为 tar.gz 决定的性能与可行性证据；默认不执行，不改只读注册表，不代表正式批量契约或写入业务包完成 | docs/experiments/transfer-benchmark-2026-10-26.md；scripts/experiments/transfer-benchmark.py；TransferBenchmarkTest.java |
| 当前产品边界 | 已有空壳、本地/批量共享契约、双端读取适配及 Windows 私有归档；没有项目管理、目标文件发布、HTTP、mDNS 或同步算法；两端写入单列 WP-009/WP-010，界面未接目录按钮 | apps/desktop、apps/mobile、development/work-packages.md |
| 固定依赖 | 采用兼容的 React 18 / TypeScript 5.9；pnpm 10.34.8；精确锁定版本和 lockfile，保留严格 peer 检查 | package.json、pnpm-lock.yaml、pnpm-workspace.yaml |
| npm 安全 | 官方 registry 对 397 项依赖复审零已知漏洞；xcode 的 uuid 定向修复为 11.1.1，已验证 CommonJS UUID 调用兼容；pnpm 独立 OSV 查询零公告 | scripts/security-check.mjs、pnpm-workspace.yaml |
| Gradle 安全 | 升级为 8.14.6；分发 ZIP 固定官方 SHA-256，Wrapper JAR 已按官方 SHA-256 验证并更新启动器 | apps/mobile/android/gradle/wrapper/、gradlew、gradlew.bat |
| Android 工具依赖 | AGP 8.13.2 与统一补丁策略已生效；全部可解析 Maven 配置（含各变体、测试、lint 和构建工具）与 Gradle Core 共 273 项复审零已知公告；包含 Protobuf 3.x 修复且保留 4.x 请求。移除未使用的 Google Services 构建插件 | apps/mobile/android/dependency-security.json、scripts/security-android.mjs |
| Android 构建与读取检查 | pnpm android:test 的 5 项 Java 单元（含 4 项 SAF 边界）、Android lint 和双 APK 构建通过；API 33 合成夹具及 API 35 真实目录分别验证读取、选择/取消和进程重启恢复，API 29 与其它提供者仍未验证 | apps/mobile/android/app/src/test、src/androidTest；testing/regression-notes.md |

## 2. 注意事项

| 事项 | 原因 | 影响 |
| --- | --- | --- |
| 依赖策略维护 | Android 模板默认构建依赖可能落后于安全补丁；npm audit 不覆盖 Maven 或包管理器 | 持续运行 security:check 与 security:android，升级策略后必须复审实际图并构建 |
