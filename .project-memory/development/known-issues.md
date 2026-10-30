---
doc_type: known-issues
status: active
priority: medium
owner: development
id_prefix: BUG
id_high_water: 6
updated: 2026-10-31
tags: [已知问题]
related_files: []
---

# 已知问题

只保留仍未解决且会影响后续工作的缺陷；解决后将长期结论吸收到当前文档并删除对应行。

| ID | 问题 | 影响 | 临时方案 | 状态 |
| --- | --- | --- | --- | --- |
| BUG-003 | 移动端传输详情轮询时，同一个文件的结果重复出现，并残留到其他页面 | 结果列表重复；切换到其他页面后旧结果面板仍然显示 | 原因：原生 jobId 就是 planId，SyncTaskDetails 里结果和计划两个同级组件 key 相同，轮询重渲染时旧结果节点留在常驻页面容器里；已改为 `outcome-`/`plan-` 前缀 | fixed；2026-10-31 在 OPD2404 调试包上 8 次轮询后结果只有 1 份，切换游戏/设备/设置/备份页无残留；原手机装新包后待复核 |
| BUG-005 | 桌面端“传输存档”没有发起传输的入口，做不了覆盖传输 | 只能从手机发起复制 | 从手机端发起，两个方向都可以 | fixed，2026-10-31 真机验证通过；按 CR-012 提前实现电脑发起：电脑选方向后请求手机扫描、在电脑确认计划，手机须开着应用并已连接 |
| BUG-006 | 不同机器构建的 Android 安装包签名不同，不能互相覆盖安装；CI 每次用新环境，Release 里的安装包也不能覆盖旧版 | 升级要先卸载，手机上的游戏配置、目录授权和私有目录里的备份随之丢失 | 原因：一直发布 debug 包，签名用各机器自动生成的调试密钥。已改为固定密钥：debug 与 release 都读 `keystore.properties` 或 `SAVEDATA_SYNC_*` 环境变量，发布工作流从 Secrets 解码密钥、构建并校验签名后发布 release 包，缺少密钥时拒绝构建 | fixing；用户生成密钥并配置本机与仓库 Secrets 后验证；已装旧签名版本的设备需卸载一次 |

验证缺口见[测试覆盖缺口](../testing/coverage-gaps.md)。
