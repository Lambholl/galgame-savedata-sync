---
doc_type: change-requests
status: active
priority: medium
owner: project
id_prefix: CR
id_high_water: 15
updated: 2026-11-04
tags: [变更请求]
related_files: []
---

# 变更请求

保留还没完整吸收到当前需求、范围或架构的变更，以及实现、验证、迁移或外部依赖仍有缺口的变更。结论完全吸收且没有缺口后删除对应行，由 Git 保存历史。

| ID | 变更 | 原因 | 影响 | 状态 |
| --- | --- | --- | --- | --- |
| CR-011 | 统一双端同一功能和页面的文案，并引入 i18n，支持 zh-CN、zh-TW、en-US、ja-JP | 两端同一功能或页面的表述要一致；后端错误原文默认英文 | 用语按原型 v2“统一用语”页：入口与页面统一叫“游戏设置”“传输详情”“传输计划”，动作动词统一为“传输”，“移除”不删文件。文案放 apps/shared。后端保留稳定错误码并使用英文原文，界面按码翻译；无错误码时显示原文。Android 通知等原生文案用 res/values-* 资源，通知语言读取已存应用偏好，未设置时跟随系统 | implemented；原生通知语言切换待真机复核 |
| CR-014 | 双端 UI v2 差异收尾与任务展示数据补齐 | 差异清单已确认，拆成纯 UI 和 UI/API 两部分 | 详细计划见 `docs/plans/ui-v2-follow-up.md`；当前界面规则见[实现细节](../development/implementation-notes.md)和[编码规范](../standards/coding-style.md)，接口见[接口约定](../architecture/api-contracts.md)第 3 节。任务留存限当前进程，不做跨重启历史 | implemented；未跑的场景和待议文案见[回归状态](../testing/regression-notes.md) |
| CR-015 | 传输页加开关：是否保留减少的文件（来源已没有、目标还留着的文件），即 REQ-014 | 开放真实存档覆盖时提出 | 目标有多出的条目时摘要行才显示开关；蓝色“− 保留”为默认，红色“− 删除”时这些条目进入计划并标红。每次进入传输页、翻转方向或重新扫描都回到保留。计划页就是删除预览：开启备份直接开始，关闭备份或来源目录为空时再确认一次。先写入后删除，删除同样先备份整个目标目录。能力版本升到 3。缺口：Activity 重建后读回开关选择未跑 | implemented |
