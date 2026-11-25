---
doc_type: known-issues
status: active
id_prefix: BUG
id_high_water: 35
updated: 2026-11-26
tags: [已知问题]
---

# 已知问题

记录已经发生、仍未解决且会影响后续工作的缺陷和阻碍；还没发生的写在[风险登记表](risks.md)。解决后将长期结论吸收到当前文档并删除对应行。

| ID | 问题 | 影响 | 临时方案 | 状态 |
| --- | --- | --- | --- | --- |
| BUG-034 | Android 从 Linux 电脑导入游戏时，取对端的 JPEG 封面失败 | 从 Linux 导入的游戏在 Android 上没有封面 | 在 Android 上重新设置封面 | open |
| BUG-035 | 电脑端服务卡片在部分窗口宽度下，地址和复制、二维码按钮伸到开关底下，或者地址单独占一行后超出卡片右边 | 地址被开关遮住或被截断 | 把窗口拉宽或拉窄到别的宽度 | open |

验证缺口见[测试覆盖缺口](../testing/coverage-gaps.md)。
