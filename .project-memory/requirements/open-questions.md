---
doc_type: open-questions
status: active
priority: medium
owner: project
id_prefix: Q
id_high_water: 8
updated: 2026-10-26
tags: [开放问题]
related_files: []
---

# 开放问题

保留问题及其结论。问题得到解答后更新“影响/结论”和状态，但不删除对应行；只有重复或错误条目可以清理，编号不得复用。

| ID | 问题 | 影响 | 负责人 | 状态 |
| --- | --- | --- | --- | --- |
| Q-001 | 是否正式选定 React + TypeScript + Vite、Windows Electron + antd、Android Capacitor + antd-mobile？ | 结论：采用该 React 双端技术栈；平台文件与发现能力按架构适配。需求与方案确认不自动授权产品编码 | 用户 | closed |
| Q-002 | 首次配对采用发现列表、扫码、配对码中的哪些入口？ | 结论：首版采用发现列表 + 手动 IP；扫码后续补充，配对码不纳入首版 | 用户 | closed |
| Q-003 | 是否在首版加入 mDNS/DNS-SD 自动发现？ | 结论：加入 mDNS/DNS-SD 自动发现及改址重连，手动 IP 兜底；稳定设备 ID 与目录配置关联，地址变化不重建映射 | 用户 | closed |
| Q-004 | 首版采用覆盖复制，还是同时提供会删除目标端独有条目的镜像模式？ | 结论：两种模式都提供，默认覆盖复制并保留目标独有条目；镜像模式让目标匹配源，执行前预览删除项 | 用户 | closed |
| Q-005 | 是否需要覆盖前备份，以及备份位置和保留策略？ | 结论：提供备份开关，默认开启，保留最近 3 次；备份放在目标端独立备份区，仅用于手工恢复，不参与同步判定 | 用户 | closed |
| Q-006 | 首版是否接受 Android 应用前台连接，以及两端均可发起任务的控制通道？ | 结论：Android 仅支持前台，后台运行和后台传输不在范围内；Android 前台连接时允许两端发起同步 | 用户 | closed |
| Q-007 | 是否为文件夹递归统计大小？ | 结论：不进行递归大小统计。文件夹自身修改日期可展示，大小建议显示“—”；同步所需的子目录枚举仍可执行 | 用户 | closed |
| Q-008 | 多小文件采用何种网络传输格式？ | 结论：双向唯一 tar.gz，按本次当前集合合批，原生 HTTP 传输，完整校验后逐项发布；无历史基线/真实存档只读边界不变。LAN/SAF 实验依据见 docs/experiments/transfer-benchmark-2026-10-26.md，正式设计见 docs/plans/m001-tar-gzip-protocol.md。用户确认无 HTTP 消费者，直接修订 v1；共享数据和 Windows 私有归档已完成并通过工程检查，Java 归档/HTTP/目标发布仍未交付，不将独立实验或单平台缓存往返当作完整验收 | 用户 | closed |
