---
doc_type: regression-notes
status: active
priority: medium
owner: testing
updated: 2026-10-28
tags: [回归测试, 当前状态]
related_files: []
---

# 当前回归状态

只保留仍需关注的问题和复验入口。单次运行记录由命令输出与 Git 保存。

| 范围 | 状态 | 当前问题 | 复验入口 |
| --- | --- | --- | --- |
| 工程检查与既有套件 | passed | 无当前失败 | `pnpm check`、`pnpm test:shared`、`pnpm test:desktop`、`pnpm test:mobile`、`pnpm android:test` |
| 当前比较共享规则 | passed | 当前内容、空目录、失败/未知、名称/类型冲突、预算、计划防伪、备份格式和逐项结果针对性运行通过；双端原生扫描/写入已复用，Java 独立计划复核与实际结果通过共享守卫 | apps/shared/src/sync；共享既有套件；文本/格式/lint/全工作区类型及双端构建 |
| 项目映射与异步发起复核 | passed | 桌面真实配置文件重启/改名/坏目录拒绝、移动适配层注入原生桥的改址/重启/异设备拒绝/通知后目录变化场景通过；新增覆盖流程尚待后续平台包 | 双端 library store/adapter；既有共享/桌面/移动套件、工程检查、桌面资源和 APK 构建 |
| Windows 当前扫描生产端 | passed | 实际临时目录的哈希/空文件/空目录/中文/缓冲区外大文件、源属性、未知长度、源变化/junction、预算/超时/取消关流/到期及 HTTP/IPC 上下文核对通过 | sync-scanner、sync HTTP、service bridge/IPC；共享/桌面既有套件与工程检查 |
| Android 当前扫描生产端 | passed | API 33 实际 SAF 的 3 文件/2 目录、独立内容哈希和源大小/mtime 核对及显式取消通过；JVM 未知长度/源变化/失效授权/预算/超时/过期、TS 桥守卫、既有共享/移动/Java 套件、工程检查及双端/APK构建通过；M-002 按用户要求不做 Android 10 实测 | SyncScanner/SafSyncSource/SyncScansPlugin、TS sync-scan bridge；不验收普通扫描的后台成败 |
| 双端界面与真机验收 | passed | 目录重组、独立界面、返回键、SAF、跨端传输和后台返回已通过真机验收 | 新构建与双端真机；见 TC-004、TC-014、TC-015 |
| 失联状态与统一提示 | passed | 注入通信中断后的未连接状态、一次性 Message、持续离线无重复、重新连接后再次失联、手机主动连接失败和活动任务查询上下文保留通过；浏览器实际页面明暗样式核对、工程检查、既有移动套件和 APK 编译通过 | 双端 App、移动 library-adapter；临时运行与页面截图，不保留界面自动化测试 |
| 新增设备默认名称 | passed | Windows 实际 HTTP 返回系统计算机名；两端首次保存使用对端名称，重连保留自定义名称；Android 系统名优先/型号后备值和 Unicode 长度规则通过 JVM 检查；33 项桌面回归、工程检查及 Android Java/lint/双 APK/归档互通通过 | http-service、双端 library store/adapter、DeviceNames、HttpTransfersPlugin |
| Windows 独立备份 | passed | 实际临时目录的原文/哈希/源属性、最近 3 次与恢复材料引用、新进程重启和设置恢复、坏设置保留、备份损坏/源变化/落盘失败/取消/超时关流/容量拒绝、轮换失败保留、显式残留清理及硬链接保护、备份根隔离和有限 IPC 通过；已供原生受保护写入与恢复复用 | backup-store/files/ipc、backup-bridge；33 项既有桌面回归及工程检查/双端构建 |
| Windows 受保护写入与恢复 | passed | 合成目录新增目录/空文件/中文、覆盖/跳过/保留、本机实际恢复及保护当前内容、输入与目标/对象身份变化、关闭备份、实际占用文件、取消/超时关流/部分完成和发布后未知结果通过；权限/不支持文件系统/空间/清理失败及候选被替换的故障注入通过，未知残留保留、显式清理重试及旧批次互斥通过 | sync-writer、sync-target-files、target-operation、directory-adapter、transfer-registry；结果通过共享守卫，33 项既有桌面回归及工程检查/双端构建通过；HTTP 编排与恢复界面待后续 |
| Android 独立备份 | passed | API 33 实际 SAF 备份、独立原文哈希及源内容/属性不变、未知长度注入、三轮保留/恢复材料引用、进程重启和正式插件查询通过；JVM 落盘失败、取消/超时关流、失效授权、容量、坏设置/损坏材料、轮换失败/残留和链接数注入通过；实际系统拒绝创建硬链接夹具。已供原生受保护写入和恢复复用；M-002 按用户要求不做 Android 10 实测 | BackupStore/Model/Files、AndroidBackupIo、SyncBackupsPlugin、TS backup bridge；共享守卫/跨语言原文核对、7 项既有移动检查、工程检查、Android 原生测试/lint/双 APK/归档互通通过 |
| Android 受保护写入与恢复 | passed | API 33 实际 SAF 创建目录/空文件、缩短/清空/恢复、覆盖前保护/三轮保留、写入中取消后的未知结果及恢复、真实目录创建竞争、异步恢复任务准备/执行/重复拒绝/取消/释放通过；原有夹具原文/大小/mtime 不变且本次子树已清理。JVM 授权/能力/目标变化、写入/落盘/清理失败、取消/超时及未知/不足/备份后余量和增量容量检查通过 | SyncPlanModel/Writer、SafSyncBackend、SyncWriteRuntime/Plugin、TargetOperation、TS bridge；共享计划/结果与新桥实例核对、正式插件、Windows 最后一项成功后的独立清理错误、既有桌面/移动/Java 套件、工程检查及 Android lint/双 APK/归档互通通过；HTTP/界面待接入 |
| Android SAF 初次访问时间变化 | unresolved | API 33 合成夹具首次读取后观察到 ctime 变化，原文和 mtime 一致，原因未确认 | 只读目录复验内容、大小和 mtime；ctime 是否变化按提供者能力记录 |
| Windows 跨进程发布恢复 | open | 强杀可能留下候选；其他卷和特殊名称等价未验证 | 独立目标夹具；按前缀自动删除或恢复旧任务不在方案内 |
| 满额规模、内存和容量预检 | passed | 双向 1 GiB、SHA-256/源属性、任务缓存清理和进程采样通过；功耗由用户取消，磁盘耗尽注入移出本轮 | 仓库根目录 `docs/validation/m001-resources.md`；双端编译、相关既有测试及容量探针 |
| 依赖手动审计 | open | 用户提供的 CI 日志报告 antd-mobile 间接依赖 deepmerge 的低危公告 GHSA-gcqx-w48m-w2h4，尚未处理 | pnpm security:check；Android 依赖另用 pnpm security:android |
| 远端 CI | pending | 用户提供的运行在 security:check 失败；安全审计已从日常 CI 移除，新配置待远端复验 | 推送后查看下一次工作流结果 |

界面检查用截图记录当时结果，不转成 DOM、选择器或颜色断言。模板、主题、基准和重复失败场景不在回归范围。
