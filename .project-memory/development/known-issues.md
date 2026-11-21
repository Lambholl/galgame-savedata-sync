---
doc_type: known-issues
status: active
id_prefix: BUG
id_high_water: 28
updated: 2026-11-21
tags: [已知问题]
---

# 已知问题

记录已经发生、仍未解决且会影响后续工作的缺陷和阻碍；还没发生的写在[风险登记表](risks.md)。解决后将长期结论吸收到当前文档并删除对应行。

| ID | 问题 | 影响 | 临时方案 | 状态 |
| --- | --- | --- | --- | --- |
| BUG-025 | 电脑设备页、传输详情页的列表项有移动端那样的悬停变色。可能是 shared/ui 共用组件或样式把移动端的交互样式带进了电脑端，两端样式的边界和复用方式可能有系统性问题，还没查。文案也有同类现象：电脑的传输计划沿用共享文案 `plan.group.replaceHint`，英文界面显示“Tap to compare both sides” | 电脑界面出现不属于电脑端的交互反馈 | 无 | open |
| BUG-027 | Android 作为目标覆盖文件很慢，耗时随同一目录里的文件数平方增长。`DirectorySyncBackend.existing` 和 `Existing.verify`（`output` 前调用）每覆盖一个文件各列一次整个父目录。实测（已授权所有文件访问权限，父目录约 480 个文件）：覆盖 22 个文件写入阶段 20.2 秒，其中 46 次列目录占 18.4 秒，每次约 0.4 秒；覆盖 504 个文件、97 MiB 前台约 466 秒、后台约 282 秒，反方向手机到电脑约 30 秒。新建文件和经 SAF 写入的路径还没测 | 大目录的游戏从电脑传到 Android 要几分钟 | 无 | open |
| BUG-028 | Android 本机服务连着电脑时停止，约一分钟内再开启必定失败，原生层报 io-failure “Cannot listen on the port”；设备页只显示“已停止”，提示消息却是通用的“读写文件失败，请确认目录仍可访问。”。可能的原因：`ListenerServer` 绑定前 `setReuseAddress(false)`，停服时本机先关闭的连接处在 TIME_WAIT，占着端口；还没核对端口占用。约两分钟后重试能成功 | 用户停服后马上重开会失败，提示把原因引向目录 | 等约一分钟再开启 | open |

验证缺口见[测试覆盖缺口](../testing/coverage-gaps.md)。
