---
doc_type: constraints
status: active
priority: medium
owner: project
updated: 2026-10-25
tags: [约束]
related_files: []
---

# 项目约束

| 类型 | 约束 | 影响 | 状态 |
| --- | --- | --- | --- |
| 平台 | Windows；Android 最低 Android 10 / API 29，编译和目标 API 36 | 已落实到原生工程 variables.gradle；后续 SDK 更新需保持最低版本 | active |
| 网络 | 同一局域网，两端同时在线；明文 HTTP、不加密 | 协议不要求证书；Android 需配置明文访问和目标系统所需的局域网权限 | active |
| 同步 | 手选方向；每次以两端当前状态为准 | 不从修改日期或历史推断权威端，不建立共同历史基线 | active |
| 预览 | 文件夹不递归计算大小 | 显示文件自身大小；文件夹大小建议显示“—”，不做后代汇总 | active |
| 配置 | IP 地址不是文件夹配置的标识 | 设备关系、连接地址、项目目录映射分别保存 | active |
| 开发方式 | 优先快速开发及双端逻辑复用；已选 React + TypeScript + Vite | Windows Electron + antd；Android Capacitor + antd-mobile，平台能力单独适配 | active |
| 连接 | 发现列表 + 手动 IP；mDNS/DNS-SD 自动发现 | 自动发现受局域网条件影响时仍可手动改址；配置不随 IP 变化丢失 | active |
| 复制模式 | 同时支持覆盖复制与镜像，默认覆盖复制 | 目标独有文件仅在明确选择镜像时列入删除计划 | active |
| 备份 | 默认开启、可关闭、保留最近 3 次 | 放在目标端独立备份区，不参与差异判定，不作为同步源内容 | active |
| Android 生命周期 | 用户发起的传输通过持续通知保持，切后台不取消 | 使用 dataSync 前台服务承接已有任务，完成/显式取消与清理后退出；不增加后台自动同步、定时/开机任务或旧任务重放 | active |
| Android 文件系统 | 使用用户实际能够授权访问的目录；SAF 属性可能未知，部分操作能力由提供者决定 | 平台约束，需真机验证；不假设所有目录可访问或所有日期可保留 | active |
| 依赖安全 | 全量检查项目直接、间接、开发及 Android 构建依赖 | 固定版本与 lockfile，命中公告应修复；审计无法完成时明确失败，不抑制已知漏洞 | active |
