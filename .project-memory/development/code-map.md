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
| `packages/shared/src/index.ts` | 应用名和共享契约导出入口 | 不包含同步算法或平台 API |
| `packages/shared/src/contracts.ts`、`protocol.ts`、`validation.ts` | 协议版本 1 DTO、错误/路由/头名映射与纯数据守卫 | 目录不汇总大小；封闭 DTO 区分空值/失败/未知结果；平台路径、权限和真实内容校验仍由适配器负责 |
| `packages/shared/test/`、`packages/shared/README.md` | 运行时/类型契约检查、完整线格式与调用示例 | pnpm test:shared 执行运行时测试，typecheck 检查类型反例，均已接入 pnpm check |
| `scripts/doctor.mjs`、`scripts/local-environment.mjs` | 开发工具入口 | 使用方式见 README |
| `scripts/android-build.mjs`、`scripts/android-open.mjs` | 原生构建、依赖清单与 IDE 入口 | 只对子进程传入 SDK/JDK；IDE 不存在时明确失败 |
| `scripts/check-text.mjs`、`eslint.config.mjs`、`tsconfig.base.json` | 编码、格式、lint 和严格类型检查 | 生成目录不作为手写代码格式化 |
| `scripts/security-check.mjs`、`scripts/toolchain-policy.mjs` | npm 全量审计、pnpm 公告与 Node 安全补丁门禁 | 查询失败不能报告通过；安全基线来自已核实的官方发行记录 |
| `scripts/android-inventory.gradle`、`scripts/security-android.mjs` | 解析 Maven 实际依赖并查询 OSV | 含运行、测试和构建图；未解析依赖导致失败；临时报告在 .reports/ |
| `.github/workflows/ci.yml` | Windows CI 与依赖审计 | Action 固定 commit SHA；security:android 入口先同步 Capacitor，远端结果见 testing/regression-notes.md |
| `README.md`、`docs/development.md` | 开发命令、工具要求与检查范围 | 版本约束以工程配置为准 |
