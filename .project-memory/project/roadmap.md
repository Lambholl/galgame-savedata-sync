---
doc_type: roadmap
status: active
priority: high
owner: project
id_prefix: M
id_high_water: 4
updated: 2026-10-25
tags: [路线图, 里程碑]
related_files: []
---

# 项目路线图

## 目录

- [1. 里程碑](#1-里程碑)
- [2. 当前计划](#2-当前计划)

只保留当前和计划中的里程碑；已完成阶段的有效结果吸收到项目目标、架构或决策后删除历史行。

## 1. 里程碑

| 里程碑 | 目标 | 计划时间 | 状态 |
| --- | --- | --- | --- |
| M-001 | 已选 React 技术栈下验证目录与 HTTP：Android 授权目录、元数据读取、前台文件往返、明文访问；验证目录不递归统计大小 | 待对应实现或原型授权后安排 | planned |
| M-002 | 最小可用双端：项目与目录映射、手动 IP、方向按钮、两端文件预览、经确认的复制规则、进度和结果 | M-001 通过后安排 | planned |
| M-003 | 地址变更与重连：mDNS/DNS-SD 自动发现列表、稳定设备关联、手动 IP 兜底和改址保留配置 | M-002 后安排 | planned |
| M-004 | 完整首版：补齐镜像模式及删除预览、默认开启的最近 3 次备份与手工恢复、两端发起及预览体验；Android 仅前台 | 核心闭环后安排 | planned |

## 2. 当前计划

| 优先级 | 事项 | 依赖 | 状态 |
| --- | --- | --- | --- |
| P0 | 在对应业务实现或原型授权后，按 M-001 验证目录与 HTTP | 需求与基础设施已就绪；目录访问与同步能力待实现 | pending |
| P0 | 按已确认的首版范围细化平台适配、接口与工作拆分 | [产品需求](../requirements/product.md)、[架构总览](../architecture/overview.md) | planned |
| P0 | 保持 Android 仅前台、当前状态独立、目录不汇总大小的边界 | [项目约束](../requirements/constraints.md)、[验收标准](../testing/acceptance.md) | active |
