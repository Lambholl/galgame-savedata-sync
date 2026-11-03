---
doc_type: change-requests
status: active
priority: medium
owner: project
id_prefix: CR
id_high_water: 14
updated: 2026-11-03
tags: [变更请求]
related_files: []
---

# 变更请求

保留还没完整吸收到当前需求、范围或架构的变更，以及实现、验证、迁移或外部依赖仍有缺口的变更。结论完全吸收且没有缺口后删除对应行，由 Git 保存历史。

最大已用编号为 14，新编号从 CR-015 起分配。

| ID | 变更 | 原因 | 影响 | 状态 |
| --- | --- | --- | --- | --- |
| CR-005 | 默认备份保护放在 M-002，使 M-002 可覆盖真实存档 | 用户在 M-002 拆包时选择 | 需求见 REQ-015；备份位置、轮次、恢复与协议见 docs/plans/m002-sync-copy.md | implementing；等 WP-029 总体验收结论 |
| CR-011 | 统一双端同一功能和页面的文案，并引入 i18n，支持 zh-CN、zh-TW、en-US、ja-JP | 两端同一功能或页面的表述要一致；后端错误原文默认英文 | 用语按原型 v2“统一用语”页：入口与页面统一叫“游戏设置”“传输详情”“传输计划”，动作动词统一为“传输”，“移除”不删文件。文案放 apps/shared。后端保留稳定错误码并使用英文原文，界面按码翻译；无错误码时显示原文。Android 通知等原生文案用 res/values-* 资源，通知语言读取已存应用偏好，未设置时跟随系统 | implemented；原生通知语言切换待真机复核 |
| CR-014 | 双端 UI v2 差异收尾与任务展示数据补齐 | 用户确认差异清单，要求拆分纯 UI 和 UI/API 两部分 | 详细计划见 `docs/plans/ui-v2-follow-up.md`；当前界面规则见[实现细节](../development/implementation-notes.md)和[编码规范](../standards/coding-style.md)，接口见[接口约定](../architecture/api-contracts.md)第 3 节。任务留存限当前进程，不做跨重启历史 | implemented；未跑的场景和待议文案见[回归状态](../testing/regression-notes.md)，与 WP-029 合并验收 |
