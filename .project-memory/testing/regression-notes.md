---
doc_type: regression-notes
status: active
priority: medium
owner: testing
updated: 2026-11-02
tags: [回归测试, 当前状态]
related_files: []
---

# 当前回归状态

只保留仍需关注的问题和复验入口。单次运行记录由命令输出与 Git 保存。

| 范围 | 状态 | 当前问题 | 复验入口 |
| --- | --- | --- | --- |
| 开屏遮罩与角色退出 | Android 13 明暗录屏复查通过 | 立绘采用用户选定的 bs2，头像大小保持不变，底部超出屏幕；第一次眨眼在 200ms 结束时展开遮罩，550ms 第二次眨眼结束并开始淡出背景，700ms 遮罩结束，停 250ms 后角色保持不透明向下滑出，1350ms 角色离屏与背景全透明同时完成。遮罩和下滑都在各自前 30% 的时间里加速，之后匀速。在明暗主题下逐帧核对最终压缩素材的时间，眼睛局部与首页显示正常，六张共 541204 字节；最新 APK 已安装 | Android 构建、lintDebug、pnpm check:text、git diff --check；旧版 Android 未真机复核 |
| 开屏头像切换宽度 | Android 13 原始录屏复查通过 | 用户发现系统开屏头像切到动画后宽了约一像素；旧录屏确认边缘宽度从 440 变为 441。改为复现系统预绘制尺寸和整数截断后，切换前后宽度均约 440 像素。最终素材统一缩小后再次复核，切换和展开时头部宽度仍约 440 像素；最新 APK 已安装 | Android 构建、lintDebug、git diff --check |
| Android 眨眼开屏 | 本地与 Android 13 真机检查通过 | 浅色和深色启动完成两次眨眼并进入首页；修复状态栏边距使头像副本短暂下移的问题，逐帧复核未见明显位移，首页布局正常。用户已确认实际播放流畅；录屏里有重复帧，无法据此判断 WebP 解码是否卡顿。五张素材由 keyframes 原图重新缩为 444×444 无损 WebP，共 328138 字节，解码结果与缩小后的 RGBA 逐像素一致；立绘 444×960、213066 字节，眼睛局部与睁眼帧相同；保留源文件。后续退出见“开屏遮罩与角色退出” | pnpm check、android:build、Android lintDebug；最新 APK 已安装到当前连接设备 |
| 游戏操作按钮悬停与点击位移 | passed | 普通态与 antd 悬停态边框宽度曾不同，主按钮点击动画又会使首子元素图标规则失效；已修正。电脑明暗五按钮、添加目录、游戏卡片、任务入口、目录行与备份策略行坐标检查通过；ADB 手机 Chrome 真实组件临时预览中，明暗五按钮内容位移均为 0.00px、禁用正常 | pnpm check、antd lint、android:build；apps/mobile/.reports/game-hover/ 复用实际组件，使用合成数据；手机本轮验证为浏览器组件预览 |
| 写入前全量备份 | 本地验证通过；手机 SAF 实机待复核 | Windows 合成目录验证原文、未变化、目标独有、嵌套和空文件全部写入备份，删除后可恢复；恢复前也会保护当前全部文件；纯新增传输同样会备份，无写入或关闭备份时跳过；缺少备份 ID 的成功结果会被拒绝，数量、单文件和总大小限制生效。Java 独立读取相同五组计划，文件集合和字节数一致，并拒绝仍按差异字节计算的旧计划 | pnpm check、test:shared/test:desktop/test:mobile、android:test；本地诊断 .reports/full-backup-probe.mjs；手机安装新 APK 后验证覆盖、纯新增及恢复的备份清单 |
| 四语言界面与英文错误原文 | passed，原生通知语言待真机复核 | 双端页面、弹窗、窗口标题和错误主提示采用四语言文案；错误原文默认英文并折叠显示。浏览器用 .reports 下模拟桥与合成元数据，核对四语言切换、英文详情、390px 移动布局与桌面长日语标题；UI 中日文字面量扫描为零。通知渠道和资源已编译核对，本轮未连接 adb | pnpm check、共享 25/桌面 33/移动 7 项测试、60 个桌面文件 antd lint、android:build、27 项 Java 单元测试及 lintDebug/测试 APK 构建；设备上的通知语言切换需手动复核 |
| Android SAF 初次访问时间变化 | unresolved | API 33 合成夹具首次读取后观察到 ctime 变化，原文和 mtime 一致，原因未确认 | 只读目录复验内容、大小和 mtime；ctime 是否变化按提供者能力记录 |
| Windows 跨进程发布恢复 | open | 强杀可能留下候选；其他卷和特殊名称等价未验证 | 独立目标夹具；按前缀自动删除或恢复旧任务不在方案内 |
| 依赖手动审计 | open | 用户提供的 CI 日志报告 antd-mobile 间接依赖 deepmerge 的低危公告 GHSA-gcqx-w48m-w2h4，尚未处理 | pnpm security:check；Android 依赖另用 pnpm security:android |

界面检查用截图记录当时结果，不转成 DOM、选择器或颜色断言。模板、主题、基准和重复失败场景不在回归范围。
