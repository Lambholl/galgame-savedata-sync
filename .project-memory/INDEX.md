---
doc_type: index
status: active
owner: project
updated: 2026-11-02
tags: [Agent导航, 项目记忆]
related_files: []
---

# 项目记忆索引

## 目录

- [1. 读取协议](#1-读取协议)
- [2. 当前工作](#2-当前工作)
- [3. 按需路由](#3-按需路由)
- [文档目录](#文档目录)

## 1. 读取协议

1. 先读本 INDEX，再根据任务和文档 `## 目录` 选择需要的原文章节。
2. 可直接使用 `rg`、`sed`、`head` 或 `cat`；需要章节切片时使用 `read --file <path> --toc|--section <标题>|--full`。
3. 任务范围变化时重新查看导航；规范、版本或路径不明确时先调查再写入。
4. 只保存项目级需求、设计、实现和验证结论，不保存特定开发机器的环境信息。

本文件提供导航、可恢复当前工作和当前文档清单，不复制项目正文。`archive/` 不进入本索引或默认搜索。完成工作由 Git 保存，INDEX 只保留仍在进行或需要接续的事项。

## 2. 当前工作

| 工作 | 状态 | 相关记忆文档 | 相关代码或配置 | 已完成 | 下一步 |
| --- | --- | --- | --- | --- | --- |
| 安卓开屏 | done | standards/coding-style.md、development/implementation-notes.md、testing/regression-notes.md | mobile MainActivity、LaunchAnimation/Plugin、启动主题与帧图、main.tsx | 系统头像随后眨眼两次，每帧 25ms，两次间隔 150ms；第一次眨眼结束后扩大遮罩，显示用户选定的 bs2 立绘，底部超出屏幕。背景在 550ms 开始淡出，遮罩 700ms 结束，停 250ms 后角色保持不透明下滑，到 1350ms 离屏且背景全透明；遮罩和下滑都在各自前 30% 的时间里从零匀加速，之后匀速。五帧从原图缩为 444×444，无损 WebP 共 328138 字节；立绘 444×960、213066 字节，六张合计 541204 字节。系统开屏头像的边距处理和像素边缘修正均保留，Android 13 明暗原始录屏复核通过，头部宽度约 440 像素；构建、lint、文本检查和 git diff 检查均通过 | 完成；最新调试 APK 已安装，保留原素材 |
| 游戏操作按钮悬停位移 | done | standards/coding-style.md、development/implementation-notes.md | shared/ui/games/games.css、GameActions；双端按钮、卡片和可点击行 | 主、次按钮保留 1px 透明边框并同步扣除内边距，修复点击动画导致首个图标字号失效的问题；目录选择按钮也改用相同规则。电脑明暗主题下，五个按钮和目录选择的内容位移均为 0，卡片、任务入口、目录行和备份策略行检查通过；通过 ADB 在手机 Chrome 中预览真实组件，明暗主题下五个按钮的点击位移均为 0.00px，禁用状态正常。pnpm check、antd lint、android:build 通过 | 完成；保留交互预览 apps/mobile/.reports/game-hover/；本轮手机验证使用临时组件页面 |
| 浅色侧栏选中项对比度 | done | standards/coding-style.md、development/implementation-notes.md | shared/ui/theme/design-theme.ts、desktop DesktopShell/Menu | 用户反馈实心蓝底太深，已改用 accentSoft 浅蓝底、accent 蓝色文字和图标；实际侧栏预览、pnpm check 与 antd lint 通过 | 完成；保留交互预览 apps/mobile/.reports/nav-color/index.html |
| 备份改为全量保存目标文件 | done | requirements/product.md、development/implementation-notes.md、testing/regression-notes.md | shared sync-plan/result、desktop backup-store/sync-writer、Android SyncPlanModel/SyncWriter/SyncJobModel/BackupModel/BackupStore；双端及 shared README | 双端改为在写入时备份全部目标文件，容量、数量和结果校验已同步；Windows 合成目录的完整备份、删除后恢复、纯新增、空文件、关闭备份、无写入和资源限制检查均通过；Java 独立验证五组计划，并拒绝仍按差异字节计算的旧计划；pnpm check、共享、桌面和移动既有测试、android:test 与项目记忆校验通过 | 实现及本地验证完成；手机安装新 APK 后复核 SAF 的覆盖、纯新增和恢复备份清单 |
| 全仓文档与项目记忆校正 | done | 本索引、architecture、requirements、development、testing | README、双端与 shared README、docs、源码注释 | 已核对 0.2.0 版本落点、全量备份、开屏、主题偏好、电脑发起和当前功能边界；按项目记忆规则清理了已提交且无缺口的历史行，保留此次未提交的 done 行；git diff --check、pnpm check、项目记忆校验通过 | 完成 |
| M-002 总体验收（WP-029） | 待验收 | development/work-packages.md、testing/acceptance.md、testing/coverage-gaps.md、testing/regression-notes.md、project/roadmap.md；场景见 `docs/plans/m002-sync-copy.md` 第 6 节 | 双端同步、备份与恢复；合成目录，隔离的电脑配置，Android 13 真机 | 用户确认与 B 阶段合并验收，写入只限合成目录（手机 gss-sync-test/wp029-a、b，电脑 .reports/wp029-pc-a、b，隔离配置 .reports/b1-desktop-profile）。已通过：两个发起端双向复制与哈希核对、保留目标独有、备份数量、第 4 份轮换、强制重启后备份仍在、双端手工恢复、双端删除备份、关闭备份确认、类型冲突阻止、确认后源或目标变化不覆盖、双端取消、电脑进程消失后手机报网络中断、两端备份失败阻止写入、两端恢复失败不改目标、结果待确认、手机空间不足、电脑目录失效、回桌面后继续并有通知、页面刷新后进度接续、写入途中被结束后两端重启都提示一次、手机由备份恢复后哈希正确、多项目、改地址保留关联、另一设备被拒、双端移除游戏删备份、资源峰值。未覆盖与待议见 testing/coverage-gaps.md、testing/regression-notes.md | 支持范围、真实存档开放条件和交接已写入 `docs/plans/m002-sync-copy.md` 第 6 节。等用户确认结论后关闭。还待用户决定：待议文案是否现在改、手机授权失效与真实 Activity 重建两项是否补测、141445454 关联数变化是否为用户操作。冻结问题暂缓；写入中断提示已实现并真机验证，不为关闭备份的传输另加警告（用户已决定） |
| Android 应用冻结后无法恢复 | 暂缓，用户之后换一台设备复测 | testing/regression-notes.md、testing/coverage-gaps.md | Android MainActivity、TransferService；真机调试脚本 `D:\tools\gss-adb.sh` | 测试手机上进程被移入 cgroup v2 `/frozen` 后，回到前台仍不解冻；手动写入 `unfrozen` 后立刻恢复。手动冻结对照浏览器后回前台同样不解冻，但这不能代表系统自己的冻结。尚未改代码 | 复测时在周期点比较本应用和对照浏览器的自然冻结与解冻，判断是否这台手机特有；再决定是否修复。方案不能假定只有 cgroup v2，SIGSTOP 也要考虑 |
| UI v2 收尾实施（CR-014） | active | requirements/change-requests.md、development/implementation-notes.md、standards/coding-style.md；详细计划 `docs/plans/ui-v2-follow-up.md` | A2 修订：shared/ui 游戏卡片、列表五段 Progress、详情 Steps/技术卡片，双端复制及触控交互，四语言 | A1 已确认。列表使用 56px 高的紧凑横条，五段 Progress 等分排列，当前段按阶段百分比局部填充；标题占用状态文字和箭头之外的全部可用宽度，超长再省略；详情保留编号 Steps。游戏操作面板的四个次级按钮去掉第二行小字，按钮高度从 52px 起，并移除了专为小字服务的备份数量查询、无用参数和文案。游戏卡片共用 3:4 占位封面，下方单行显示并省略游戏名；悬停时只给封面轻微着色，卡片没有边框，也不改变整块背景。技术卡片在手机上点击切换，长按复制后保持展开；桌面端在右上角复制；手势提示已删除。工程检查、antd lint、Android 构建通过，手机长按复制与桌面窄窗检查通过；真实失败阶段在 B1，更早任务查询在 B4 | A2、A3 已确认。A3：比较进度只写在共用 TransferStatus 状态栏，两列独立滚动、列头固定；文件列两端统一按列宽切换（400px 以上表格一行名称，更窄两行名称加时间/大小，过长省略），文件夹差异改为整行着色；游戏设置页去掉重复游戏名；列表时间为 yy-MM-dd HH:mm，电脑底栏去掉路线说明。追加完成设计变量统一：色板、圆角、字体只在 shared design-tokens.ts，designTheme 生成两端 ConfigProvider 主题，installDesignTokens 写出 --ss-* 变量，散落的颜色与离档圆角已改为变量。再次修订：左来源右目标与主色交换按钮，~/+/− 彩色差异标签与文件行同色（新增绿、覆盖琥珀、保留蓝，删除留作红色），进度说明移到摘要行并统一为“正在比较两端”，“差异”筛选与图标刷新，时间/大小字号缩小，底部只留悬浮胶囊主按钮，按钮统一胶囊不换行。pnpm check、antd lint 通过，浏览器预览在 apps/mobile/.reports/preview/a3-mobile.html、a3-desktop.html（mobile-web 服务） | A1–A4 已于 2026-11-02 获用户确认，A 阶段完成；B 阶段的验证结果见 testing/regression-notes.md。A4 内容：详情右下角单个悬浮主操作、桌面居中窄栏、查看备份整行入口、技术详情与已写入同一种可展开行和展开动画、错误不再有“详情”开关、页面失败改用 Message 提示一次、电脑新增传输结束提示；追加：悬停统一 ss-pressable 叠加、备份文件复用传输文件列（FilePane/BackupFiles）、恢复改为独立页面并复用计划确认页（电脑 PlanDrawer、手机 PlanConfirm 与 restore 页）；pnpm check、shared 测试、antd lint 通过，这一批按用户要求不再开预览；早先预览 a4-mobile.html、a4-desktop.html；另修复电脑游戏卡片名称与摘要重叠（game-card.css 对卡片取消按钮文字的 text-box 裁剪） |
| UI 改版 v2 四语言文案与 Android 通知 | done | requirements/change-requests.md（CR-011）、development/implementation-notes.md、standards/coding-style.md、testing/regression-notes.md | 双端 app/components/features/platform、shared i18n/result/ui、desktop main、Android Java/res | 四语言界面、窗口/选择器标题、错误码主提示与英文原文详情完成；后端自有错误统一英文，Android 通知与 app_name 四语言资源完成并读取已存语言。共用参数已导出注释，桌面长日语名称会换行。pnpm check、共享 25/桌面 33/移动 7 项、60 个桌面文件 antd lint、Android 构建/27 项单元/lint/测试 APK 通过，双端四语言浏览器与 APK 资源检查通过，中日文字面量扫描无残留 | 第 9 步完成；通知语言切换尚需手动真机复核，本轮未连接 adb；项目总体验收仍按原登记继续 |
| Android 固定签名（BUG-006） | active | development/known-issues.md | apps/mobile/android/app/build.gradle、scripts/android-build.mjs、package.json android:release、.github/workflows/release.yml、docs/development.md、.gitignore | 用户选定私有密钥 + GitHub Secrets，Release 改发 release 包；签名配置、release 构建脚本、发布工作流与开发文档已改，用临时测试密钥验证构建；用户已生成正式密钥，本机 android:release 成功。补充 keystore.properties.example、自编译/fork/密钥丢失或泄露指引，发布工作流开头检查 Secrets，check-text 跳过本机 keystore.properties；未提交 | 用户配置四个 Secrets 后提交，下次发布验证 CI 产物可覆盖本机构建的包 |

开始产品、代码或文档工作前登记范围、入口和下一步；检查点、阻塞和完成时更新。完成时先更新长期事实，再记录完成状态与结果。

## 3. 按需路由

| 任务信号 | 首选目录 | 说明 |
| --- | --- | --- |
| 目标、术语、路线图 | `project/` | 读取命中的当前章节 |
| 需求、范围、约束 | `requirements/` | 以当前表述和开放问题为准 |
| 当前架构、接口、数据流、决策 | `architecture/`、`decisions/` | 先看事实，再按需看决策理由 |
| 实现、模块、代码地图 | `development/` | 关注当前状态、入口和工作包 |
| 代码实现或代码测试 | 项目规范、通用编码规则和匹配语言规则 | 只读取与目标文件匹配的规范 |
| 测试策略、用例、验收 | `testing/`、`standards/testing-style.md` | 按当前验证范围选择章节 |
| 风险、问题、依赖 | `governance/` | 只保留仍开放或仍有效的项 |
| Git 提交 | `standards/commit-style.md` | 需要提交时读取 |

## 文档目录

| 文档 | 标题 | 状态 | 标签 |
| --- | --- | --- | --- |
| `architecture/api-contracts.md` | 接口约定 | active | API, 接口约定 |
| `architecture/data-flow.md` | 数据流 | draft | 数据流 |
| `architecture/dependencies.md` | 架构依赖 | draft | 依赖 |
| `architecture/modules.md` | 模块设计 | draft | 模块 |
| `architecture/overview.md` | 架构总览 | active | 架构总览 |
| `decisions/ADR-0002-ui-library-and-shared-rendering.md` | ADR-0002 维持 antd 系列，抽取双端共用渲染 | accepted | 决策, 界面, 组件库, 共用组件 |
| `development/code-map.md` | 代码地图 | active | 代码地图 |
| `development/implementation-notes.md` | 实现细节 | active | 实现细节 |
| `development/known-issues.md` | 已知问题 | active | 已知问题 |
| `development/module-status.md` | 模块状态 | active | 模块状态, 开发进度 |
| `development/work-packages.md` | 工作包登记 | active | 工作包, M-002, 验收 |
| `governance/assumptions.md` | 项目假设 | active | 假设 |
| `governance/dependencies.md` | 外部依赖 | active | 外部依赖 |
| `governance/issues.md` | 问题登记表 | active | 问题 |
| `governance/risks.md` | 风险登记表 | active | 风险 |
| `project/charter.md` | 项目章程 | active | 项目目标, 成功标准 |
| `project/glossary.md` | 项目术语表 | draft | 术语 |
| `project/roadmap.md` | 项目路线图 | active | 路线图, 里程碑 |
| `project/stakeholders.md` | 干系人与角色 | draft | 干系人, 角色 |
| `requirements/change-requests.md` | 变更请求 | active | 变更请求 |
| `requirements/constraints.md` | 项目约束 | active | 约束 |
| `requirements/open-questions.md` | 开放问题 | active | 开放问题 |
| `requirements/product.md` | 产品需求 | active | 产品需求 |
| `requirements/scope.md` | 项目范围 | active | 范围 |
| `requirements/user-stories.md` | 用户故事 | draft | 用户故事 |
| `standards/api-style.md` | API 规范 | draft | API规范 |
| `standards/chinese-commit-conventions.md` | 中文 Git 提交规范 | unspecified | - |
| `standards/coding-style.md` | 项目级编码规范 | active | 编码规范 |
| `standards/commit-style.md` | 提交规范 | active | 提交规范 |
| `standards/testing-style.md` | 测试规范 | active | 测试规范 |
| `testing/acceptance.md` | 验收标准 | active | 验收标准 |
| `testing/coverage-gaps.md` | 测试覆盖缺口 | active | 测试缺口 |
| `testing/regression-notes.md` | 当前回归状态 | active | 回归测试, 当前状态 |
| `testing/strategy.md` | 测试策略 | active | 测试策略 |
| `testing/test-cases.md` | 测试用例 | active | 测试用例 |
