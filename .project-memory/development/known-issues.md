---
doc_type: known-issues
status: active
priority: medium
owner: development
id_prefix: BUG
id_high_water: 7
updated: 2026-11-02
tags: [已知问题]
related_files: []
---

# 已知问题

只保留仍未解决且会影响后续工作的缺陷；解决后将长期结论吸收到当前文档并删除对应行。

| ID | 问题 | 影响 | 临时方案 | 状态 |
| --- | --- | --- | --- | --- |
| BUG-006 | 不同机器构建的 Android 安装包签名不同，不能互相覆盖安装；CI 每次用新环境，Release 里的安装包也不能覆盖旧版 | 升级要先卸载，手机上的游戏配置、目录授权和私有目录里的备份随之丢失 | 原因：一直发布 debug 包，签名用各机器自动生成的调试密钥。已改为固定密钥：debug 与 release 都读 `keystore.properties` 或 `SAVEDATA_SYNC_*` 环境变量，发布工作流从 Secrets 解码密钥、构建并校验签名后发布 release 包，缺少密钥时拒绝构建 | fixing；用户生成密钥并配置本机与仓库 Secrets 后验证；已装旧签名版本的设备需卸载一次 |

验证缺口见[测试覆盖缺口](../testing/coverage-gaps.md)。
