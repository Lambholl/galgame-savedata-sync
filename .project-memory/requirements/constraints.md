---
doc_type: constraints
status: active
priority: medium
owner: project
updated: 2026-11-03
tags: [约束]
related_files: []
---

# 项目约束

| 类型 | 约束 | 影响 | 状态 |
| --- | --- | --- | --- |
| 平台 | Windows；Android 最低 Android 10 / API 29，编译和目标 API 36 | 写在原生工程 variables.gradle；SDK 更新时保持最低版本 | active |
| 网络 | 同一局域网，两端同时在线；明文 HTTP、不加密 | 协议不要求证书；Android 需配置明文访问和目标系统所需的局域网权限 | active |
| 同步 | 手选方向；每次以两端当前状态为准 | 不从修改日期或历史推断权威端，不建立共同历史基线 | active |
| 预览 | 文件夹不递归计算大小 | 显示文件自身大小；文件夹大小建议显示“—”，不做后代汇总 | active |
| 配置 | IP 地址不是文件夹配置的标识 | 设备关系、连接地址、项目目录映射分别保存 | active |
| 开发方式 | React + TypeScript + Vite；共用协议、数据模型、业务规则，以及与两端交互差异无关的界面渲染（ADR-0002）；平台交互、页面状态与 Hook 各端实现 | apps 下分为 mobile、desktop、shared，共用渲染走 `@savedata-sync/shared/ui`；Windows Electron + antd；Android Capacitor，优先 antd-mobile，使用 antd 时也考虑触控；平台能力各自适配 | active |
| 连接 | 发现列表 + 手动 IP；mDNS/DNS-SD 自动发现 | 自动发现受局域网条件影响时仍可手动改址；配置不随 IP 变化丢失 | active |
| 复制模式 | 同时支持覆盖复制与镜像，默认覆盖复制 | 目标独有文件仅在明确选择镜像时列入删除计划 | active |
| 备份 | 默认开启、可关闭，每个游戏保留 1–10 份（默认 3 份） | 有写入时保存目标目录全部文件；放在目标端独立备份区，不参与差异判定，不作为同步源内容 | active |
| Android 生命周期 | 业务不判断前后台状态；仅传输保活 | 普通目录、扫描、连接和查询不处理切后台后的成败；传输使用 dataSync 前台服务和持续通知，保留显式取消、期限和实际错误处理；不增加自动同步、定时/开机任务或旧任务重放 | active |
| Android 文件系统 | 使用用户实际能够授权访问的目录；SAF 属性可能未知，部分操作能力由提供者决定 | 按提供者实际能力处理目录和日期 | active |
| 依赖安全 | 手动命令全量检查项目直接、间接、开发及 Android 构建依赖，日常 CI 移除安全审计步骤 | 固定版本与 lockfile，命中公告应修复；手动审计无法完成时明确失败，不抑制已知漏洞 | active |
