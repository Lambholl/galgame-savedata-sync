---
doc_type: glossary
status: draft
updated: 2026-11-14
tags: [术语]
related_files: []
---

# 项目术语表

| 术语 | 含义 | 备注 |
| --- | --- | --- |
| 用户 | 应用的使用者 | 不指项目维护者 |
| 维护者 | 决定需求、验收和 Git 操作的项目负责人 | 文档里流程上的确认、验收和待决定都由维护者做出，不能由执行者自己给出；不含应用界面里的确认操作 |
| 移动端 | 运行 Android 应用的设备，包括手机和平板；与“电脑端”相对 | 界面文案：zh-TW“行動端”，en-US“mobile device”或“Mobile”，ja-JP“モバイル端末”或“モバイル”。只有说具体硬件时才写手机或平板。协议字段 `ErrorDevice` 的取值 `phone` 已发布，协议变化前不改名 |
| 界面用语 | 两端入口和页面统一叫“游戏设置”“传输详情”“传输计划”，动作动词统一用“传输”；“移除”游戏删除它的配置、设备关联和备份，不删存档文件 | 四种语言的文案在 `apps/shared`；后端错误原文用英文，界面按错误码翻译 |
| 批量传输 | 只新建文件的传输任务，状态是 `BatchState` | 电脑端 `WindowsTransferRegistry`，移动端 `TransferEngine` |
| 复制任务 | 按计划覆盖、新建或删除文件的传输任务，状态是 `SyncJobState` | 电脑端 `WindowsSyncRegistry`，移动端 `SyncTransferEngine` |
| 目录表 | 设备之间交换的游戏和目录列表 | 代码里的 catalog |
| 轮次 | 一份备份 | 代码里的 round |
| 名额 | 进程内同一时刻只允许一个批量传输、复制任务或恢复运行的互斥，从接受任务占到清理结束 | `TargetOperation`；归档缓存和文件发布各有自己的名额 |
| 候选文件 | 写入目标目录前的临时文件，校验通过后才变成最终文件 | 代码里的 candidate |
| 发布 | 把校验过的候选文件变成目标目录里的最终文件 | 代码里的 publish |
| 残留 | 未提交、未清理完的备份轮次、缓存或候选文件 | 代码里的 incomplete、cleanup、residual |
