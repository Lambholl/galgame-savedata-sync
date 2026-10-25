---
doc_type: implementation-notes
status: active
priority: medium
owner: development
updated: 2026-10-25
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
| 当前产品边界 | 已有可启动空壳，没有项目管理、存档目录访问、HTTP 服务、mDNS 或同步算法 | apps/desktop、apps/mobile |
| 固定依赖 | 采用兼容的 React 18 / TypeScript 5.9；pnpm 10.34.8；精确锁定版本和 lockfile，保留严格 peer 检查 | package.json、pnpm-lock.yaml、pnpm-workspace.yaml |
| npm 安全 | 官方 registry 对 397 项依赖复审零已知漏洞；xcode 的 uuid 定向修复为 11.1.1，已验证 CommonJS UUID 调用兼容；pnpm 独立 OSV 查询零公告 | scripts/security-check.mjs、pnpm-workspace.yaml |
| Gradle 安全 | 升级为 8.14.6；分发 ZIP 固定官方 SHA-256，Wrapper JAR 已按官方 SHA-256 验证并更新启动器 | apps/mobile/android/gradle/wrapper/、gradlew、gradlew.bat |
| Android 工具依赖 | AGP 8.13.2 与统一补丁策略已生效；全部可解析 Maven 配置（含各变体、测试、lint 和构建工具）与 Gradle Core 共 273 项复审零已知公告；包含 Protobuf 3.x 修复且保留 4.x 请求。移除未使用的 Google Services 构建插件 | apps/mobile/android/dependency-security.json、scripts/security-android.mjs |
| Android 构建 | debug APK 已成功构建；归档 Manifest 确认 minSdk 29、targetSdk 36、usesCleartextTraffic=true；未部署设备 | apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk |

## 2. 注意事项

| 事项 | 原因 | 影响 |
| --- | --- | --- |
| 依赖策略维护 | Android 模板默认构建依赖可能落后于安全补丁；npm audit 不覆盖 Maven 或包管理器 | 持续运行 security:check 与 security:android，升级策略后必须复审实际图并构建 |
