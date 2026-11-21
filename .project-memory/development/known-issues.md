---
doc_type: known-issues
status: active
id_prefix: BUG
id_high_water: 28
updated: 2026-11-22
tags: [已知问题]
---

# 已知问题

记录已经发生、仍未解决且会影响后续工作的缺陷和阻碍；还没发生的写在[风险登记表](risks.md)。解决后将长期结论吸收到当前文档并删除对应行。

| ID | 问题 | 影响 | 临时方案 | 状态 |
| --- | --- | --- | --- | --- |
| BUG-028 | Android 本机服务连着电脑时停止，约一分钟内再开启必定失败，原生层报 io-failure “Cannot listen on the port”；设备页只显示“已停止”，提示消息却是通用的“读写文件失败，请确认目录仍可访问。”。可能的原因：`ListenerServer` 绑定前 `setReuseAddress(false)`，停服时本机先关闭的连接处在 TIME_WAIT，占着端口；还没核对端口占用。约两分钟后重试能成功 | 用户停服后马上重开会失败，提示把原因引向目录 | 等约一分钟再开启 | open |

验证缺口见[测试覆盖缺口](../testing/coverage-gaps.md)。
