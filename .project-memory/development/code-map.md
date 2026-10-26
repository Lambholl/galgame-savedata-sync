---
doc_type: code-map
status: active
priority: medium
owner: development
updated: 2026-10-26
tags: [代码地图]
related_files: []
---

# 代码地图

| 路径 | 作用 | 重要约定 |
| --- | --- | --- |
| `package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml` | pnpm 工作区、固定版本与工程入口 | 私有工作区；使用指定 pnpm，不依赖系统全局 Gradle |
| `apps/desktop/` | Electron 主进程、preload 和 antd 空壳 | Renderer 无 Node 集成；contextIsolation 和 sandbox 开启 |
| `apps/desktop/src/main/directory-adapter.ts`、`directory-store.ts`、`directory-paths.ts`、`directory-errors.ts` | 目录选择登记、独立配置、当前层元数据、根内原生读流及脱敏错误 | 没有源目录写入 API；拒绝 symlink/junction 与失效身份，配置不保存历史文件索引 |
| `apps/desktop/src/directory-bridge.ts`、`src/main/directory-ipc.ts`、`src/preload/index.ts` | 三个有限目录方法与 IPC 来源/参数/返回校验 | 绝对路径和文件内容不跨桥；handler 在退出时移除；main/preload 内联共享包 |
| `apps/desktop/test/`、`apps/desktop/README.md` | Windows 临时目录/IPC 测试与接口说明 | pnpm test:desktop 已接入 pnpm check；真实目录仅只读验证，机器路径不提交 |
| `apps/mobile/` | antd-mobile 空壳、Vite 与 Capacitor 配置 | 网页预览不等于 Android 原生能力验证 |
| `apps/mobile/android/` | Capacitor 生成的原生工程与项目 Wrapper | minSdk 29、compile/target 36；Manifest 明文 HTTP；不增加后台服务 |
| `apps/mobile/android/app/src/main/java/io/github/galgame/savedatasync/` | Java SAF 只读选择、权限/配置恢复、当前层元数据和原生流 | URI 留原生层，READ 持久授权，原生流调用者负责关闭；配置不保存条目或哈希 |
| `apps/mobile/src/saf-directory-bridge.ts`、`saf-directories.ts`、`test/`、`README.md` | 受限 TS 桥、原生绑定、契约测试与调用说明 | 网页预览不支持；只传公开 DTO/ID，无内容/写入方法；pnpm test:mobile 纳入 check |
| `apps/mobile/android/app/src/test/`、`src/androidTest/` | Java 纯边界与设备仪器测试 | 默认仅独立私有夹具和桥检查；交互模式由真实选择器授权，真实目录只读 |
| `apps/mobile/android/app/src/debug/`、`src/androidTest/java/io/github/galgame/savedatasync/TransferBenchmarkTest.java`、`scripts/experiments/transfer-benchmark.py` | 手工启用的真实 LAN/SAF 双向性能实验 | 只授权全新测试树写入，有限缓冲、逐项写后回读、私有副本和清理；默认跳过，debug Activity 不导出，release 不含入口；不替代正式 HTTP/写入适配 |
| `docs/experiments/transfer-benchmark-2026-10-26.md`、同名 CSV | 54 组匿名性能结果与复验方法 | 三个样本对应用户输入顺序；只保存计数、体积和耗时，不保存原路径、文件名或原始哈希 |
| `packages/shared/src/index.ts` | 应用名和共享契约导出入口 | 不包含同步算法或平台 API |
| `packages/shared/src/contracts.ts`、`protocol.ts`、`validation.ts` | 协议版本 1 DTO、错误/路由/头名映射与纯数据守卫 | 目录不汇总大小；封闭 DTO 区分空值/失败/未知结果；平台路径、权限和真实内容校验仍由适配器负责 |
| `packages/shared/src/batch-contracts.ts`、`batch-limits.ts`、`batch-validation.ts`、`batch-context.ts`、`data-validation.ts` | v1 批量 DTO、固定预算/期限、结构/关系守卫与任务上下文匹配；基础容器/文本/数值辅助供内部复用 | sender/receiver 分开；清单与目标一一对应；matchesBatchState 核对实际结果；无归档、HTTP、IO 或历史存储 |
| `packages/shared/test/`、`packages/shared/README.md` | 运行时/类型契约检查、完整线格式与调用示例 | pnpm test:shared 执行运行时测试，typecheck 检查类型反例，均已接入 pnpm check |
| `scripts/doctor.mjs`、`scripts/local-environment.mjs` | 开发工具入口 | 使用方式见 README |
| `scripts/android-build.mjs`、`scripts/android-open.mjs` | 原生构建、单元/lint/双 APK 检查、依赖清单与 IDE 入口 | pnpm android:test 不连接设备；只对子进程传入 SDK/JDK；IDE 不存在时明确失败 |
| `scripts/check-text.mjs`、`eslint.config.mjs`、`tsconfig.base.json` | 编码、格式、lint 和严格类型检查 | 生成目录不作为手写代码格式化 |
| `scripts/security-check.mjs`、`scripts/toolchain-policy.mjs` | npm 全量审计、pnpm 公告与 Node 安全补丁门禁 | 查询失败不能报告通过；安全基线来自已核实的官方发行记录 |
| `scripts/android-inventory.gradle`、`scripts/security-android.mjs` | 解析 Maven 实际依赖并查询 OSV | 含运行、测试和构建图；未解析依赖导致失败；临时报告在 .reports/ |
| `.github/workflows/ci.yml` | Windows CI 与依赖审计 | Action 固定 commit SHA；security:android 入口先同步 Capacitor，远端结果见 testing/regression-notes.md |
| `README.md`、`docs/development.md` | 开发命令、工具要求与检查范围 | 版本约束以工程配置为准 |
