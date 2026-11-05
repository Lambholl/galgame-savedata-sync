---
doc_type: coding-style
status: active
priority: high
owner: development
updated: 2026-11-05
tags: [编码规范]
related_files: []
---

# 项目级编码规范

## 目录

- [1. 规范来源](#1-规范来源)
- [2. 维护边界](#2-维护边界)
- [3. 命名规范](#3-命名规范)
- [4. 目录与模块规范](#4-目录与模块规范)
- [5. 错误处理与日志](#5-错误处理与日志)
- [6. 版权信息](#6-版权信息)
- [7. 接口与函数说明](#7-接口与函数说明)
- [8. 代码注释](#8-代码注释)
- [9. 自动化检查与边界](#9-自动化检查与边界)

## 1. 规范来源

| 来源 | 路径 | 优先级 | 状态 |
| --- | --- | --- | --- |
| 自动化配置 | `.editorconfig`、`.gitattributes`、`.prettierrc.json`、`.prettierignore`、`eslint.config.mjs`、`apps/mobile/android/checkstyle.xml`、`tsconfig.base.json`、`package.json` | P0 | active |
| Skill 通用规范入口 | `references/general-standards/language-baseline.md` | P1 | active |
| Skill 通用编码规则 | `references/general-standards/common-rules.md` | P1 | active |
| 项目记忆 | 本文件 | P2 | active |
| 现有代码风格 | `apps/`、`apps/shared/`、`scripts/` | P3 | active |

## 2. 维护边界

| 类型 | 写入位置 | 规则 |
| --- | --- | --- |
| 通用语言规范基线 | Skill 自身 `references/general-standards/` | 不在项目模板中私自修改 |
| 项目级覆盖和差异 | 本文件或同目录规范文件 | 记录差异原因、适用范围和生效条件 |
| 自动化格式规则 | `.prettierrc.json`、`.editorconfig` | 排版设置维护一份；ESLint 使用 `eslint-config-prettier/flat` 关闭冲突规则，随后为 TS/TSX 启用 `curly: all` 和 `arrow-body-style: as-needed`；Java 同样由 Prettier 排版，`checkstyle.xml` 去掉和它冲突的规则 |

## 3. 命名规范

| 类型 | 规则 | 示例 |
| --- | --- | --- |
| 手写 TS/JS 与 React | 遵循语言基线；React 组件 PascalCase，普通脚本与模块 kebab-case，优先命名导出 | `App.tsx`、`toolchain-policy.mjs` |
| TypeScript 布尔值 | 变量、参数、类属性和类型属性使用语义前缀加 PascalCase 主体；允许 `is`、`has`、`can`、`should`、`was`、`were`、`did`、`do`、`will`、`must`、`may`、`need`、`require`、`allow`、`support`、`accept`、`contain`、`include`、`exist`、`match`、`use`、`own` | `isConnected`、`hasPermission`、`canRetry`、`shouldRefresh`、`wasCancelled`、`allowEmpty` |
| Java 布尔值 | 变量、参数和字段使用和 TypeScript 相同的语义前缀；`static final` 常量按 UPPER_SNAKE_CASE | `isRunning`、`hasTimedOut`、`shouldBackup` |
| 框架约定 | Vite、Capacitor、ESLint 配置按框架要求默认导出 | `vite.config.ts`、`capacitor.config.ts` |

## 4. 目录与模块规范

| 规则 | 原因 |
| --- | --- |
| Agent 开发准入 | 按目标路径发现并读取实际存在且适用的 `AGENTS.md`；桌面应用规则位于 `apps/desktop/AGENTS.md`，要求完整读取 `antd` skill；编写 Ant Design 组件时按 Skill 查询实际版本 API |
| 平台边界 | 源码分为 `apps/mobile`、`apps/desktop`、`apps/shared`。按 ADR-0002，与两端交互差异无关的计算和渲染放 shared：主入口 `@savedata-sync/shared` 保持纯 TypeScript，不引入 React、组件库、DOM、Node、Electron 或 Android 接口，供电脑主进程、协议与 node 测试使用；界面入口 `@savedata-sync/shared/ui`（`apps/shared/src/ui`）可用 React、`@ant-design/icons` 和不涉及平台交互的 antd 组件（如 Flex），禁止 antd-mobile、Electron、Capacitor、Node 与平台接口，主入口不得导入它。弹层、抽屉、返回键、系统选择器、确认、提示消息等平台交互，以及页面状态与 Hook 留在各端；平台能力留在各应用适配层。ESLint 限制跨应用源码导入和 shared 依赖：主入口禁止 React、组件库与 `src/ui`，ui 入口禁止 antd-mobile、react-dom、Electron、Capacitor 与 Node；ui 用独立的 `src/ui/tsconfig.json`（含 DOM），主入口 tsconfig 排除它 |
| 共用界面组件参数 | shared/ui 组件的 Props 类型全部命名导出，每个参数用 TSDoc 写明用途；不接受、不透传 `style`、`className`、`styles`、`classNames` 或任意剩余属性。两端差异只能通过含义明确的参数表达（方向、尺寸、边距档位、紧凑程度等）；功能相近的一组参数可以合并为一个导出的结构化类型（如 `layout: PaneLayout`）。原因：共用组件接口要可读，两端只能按约定的方式变化 |
| 设计变量与样式管理 | 颜色、圆角和字体的取值只写在 `apps/shared/src/preferences/design-tokens.ts`（PALETTES / RADII / FONTS，按原型 v2）。shared/ui 的 `designTheme(theme, platform)` 由它生成两端 antd ConfigProvider 主题，两端组件密度差异也集中在这里；`installDesignTokens()` 在应用入口把它写成 `--ss-*` 变量；电脑原生窗口背景读 PALETTES。样式表只引用 `--ss-*`，antd-mobile 的 `--adm-*` 在 mobile.css 开头统一映射到 `--ss-*`；组件和样式表不写颜色、圆角、字体的字面值，也不用 style 写外观（antd-mobile 的 `--z-index` 等组件参数和布局尺寸除外）。圆角档位：xs 6 小图标底，sm 10 输入框与分段控件，md 14 分组容器、卡片、文件列和大图标底，lg 22 弹层，pill 按钮与标签，圆形用 50%。按钮文字不换行，放不下时改短文字或调整按钮，不靠样式折行；按钮文字用 text-box 按大写字母高度裁边后居中。差异颜色两端统一：新建绿、覆盖琥珀、只在目标且保留为蓝、删除为红，标签与文件行同色。原因：样式要统一管理，不能散落各处 |
| 现有组件优先 | 界面优先复用 antd 的展示组件：列表中的紧凑进度使用 Progress steps，五段等分；详情使用带编号的 Steps，阶段名放在下方，并显示当前阶段的 percent；圆形进度使用 Progress，操作使用 Button。五段表示流程位置，当前段按本阶段计数局部填充（50% 为半段），不按五等分估算总耗时。取消传输使用外形和点击范围都清楚的普通按钮；移动弹层等平台交互沿用 antd-mobile |
| 移动组件与触控 | 优先使用 antd-mobile，按实际需要使用 antd。尺寸参照 QQ 界面：普通按钮 45 CSS px 起、整行主操作 50 CSS px 起；图标点击区 36 CSS px 起，选项行约 44–52 CSS px；游戏主操作 56 CSS px、次级操作卡片 52 CSS px 起。标题 18px、常用文字和按钮 14px、辅助文字 12px；长文字换行后可增长高度（按钮除外，见“设计变量与样式管理”），常规字号和窄屏下保持可读、可点按 |
| 界面反馈与可展开行 | 不放“详情”这类折叠开关，也不用文字链接式按钮（移动端上没有点按反馈）：入口做成整行可点的行（图标、文字、右箭头），行内操作用小胶囊 Button。错误只显示本地化说明，原始消息与错误码在电脑上悬停可见，任务详情里写进技术详情。所有 Message 都走各端 `app/app-message.ts` 的 useAppMessage（ESLint 禁止别处直接用 antd 的 message）：每条用新 key，需要互相替换的提示用同一个 slot，因为重开退场中的同 key 提示时计时不会重启，提示会一直不消失。页面的失败信息用 Message 提示一次（各端 `app/failure-message.ts` 的 useFailureMessage，同一失败连续出现只提示一次），不放红色横幅；读不到内容时正文留带“重试”的空状态；传输结束双端各用 Message 提示一次结果。任务结论、失败文件原因和比较状态栏属于记录，留在页面上。可展开的内容统一用 shared/ui 的 Expand 与 ExpandChevron：朝下箭头展开后转 180°，高度平滑过渡。可点的行与卡片加 ss-pressable，悬停和按下只叠加渐显的低透明前景色，不直接改背景色。外观相同的界面直接复用：文件列表用 FilePane，计划确认用电脑 PlanDrawer、移动端 PlanConfirm，恢复等流程打开新页面，不在原页面里切换内容 |
| 原生生成工程 | `apps/mobile/android/` 下除 `app/src` 的 Java 外保留原生工具风格，不用 Prettier 重写；手写改动仍需检查 UTF-8 与换行 |
| Android Java | 沿用 Java，遵循 Skill `references/general-standards/languages/java.md`；和它的差异见第 9 节。原生代码用 Checkstyle、javac、Android lint、单元/仪器测试验证，不为本包引入 Kotlin 插件 |
| 检查入口 | `pnpm check` 执行文本、格式、lint（ESLint 和 Checkstyle，后者需要 JDK）、类型检查和双端构建；`pnpm test:all` 单独运行全量测试；`security:check` / `security:android` 分别审计 Node 工具链及 Maven |
| Windows 交付 | 默认只编译桌面运行资源，不重新生成安装版或免安装版；完整打包须有维护者新的明确要求。Android 按原入口生成 APK |
| 版本控制边界 | 忽略清单以 `.gitignore` 为准，生成产物与临时报告不进入 Git；界面原型只留在本地（`docs/design/`、`.reports/`，都已忽略） |

## 5. 错误处理与日志

| 场景 | 规则 |
| --- | --- |
| CLI 或网络检查失败 | 显式非零退出，不把下载、解析或审计失败当作成功 |
| Electron 异步启动 | 捕获加载/初始化错误，保留原始错误上下文；preload 仅暴露明确的只读边界 |
| 工具日志 | 不输出密钥、代理凭据或其他敏感配置；完整命令历史不写入记忆 |

## 6. 版权信息

版权信息以项目实际作者、现有许可证和项目约定为准。还没明确的署名信息保持待确认。

| 场景 | 规则 |
| --- | --- |
| 默认规则 | 遵循项目现有许可证和明确的作者署名；未明确时不新增版权主体 |
| 项目差异 | 项目使用 AGPL-3.0，见根目录 `LICENSE`；不另加许可证或版权主体，第三方版权与许可声明保留原文 |

## 7. 接口与函数说明

| 对象 | 说明内容 |
| --- | --- |
| 对外 API / CLI 命令 | 输入参数、输出结构、错误码或异常、兼容性约束、示例位置。 |
| 公开函数 / 模块接口 | 参数含义、返回值、副作用、错误行为、调用前置条件。 |
| 配置项 / 数据结构 | 字段含义、默认值、取值范围、迁移或兼容性影响。 |
| FFI / 跨语言边界 | 所有权、生命周期、线程安全、内存释放责任、异常或错误码传递方式。 |

## 8. 代码注释

| 场景 | 规则 |
| --- | --- |
| 注释语言 | 遵循 Skill `references/general-standards/common-rules.md` 的跨语言中文注释规则；覆盖源码、配置及文档代码示例，第三方版权与许可声明保留原文。 |
| 必要注释 | 函数和类的注释先说明功能（做什么、操作什么数据、返回什么）；之后再补充读代码看不出的业务规则、边界条件、安全和隐私约束、非显然算法和兼容性取舍。行内注释写原因和后果。 |
| 写法 | 写给第一次读这段代码的维护者：用完整的句子和代码里查得到的名称，写明具体是什么数据、什么期限、由谁调用。术语要能在代码或 `project/glossary.md` 里查到。详细规则见 Skill `references/general-standards/common-rules.md` 的“注释原则”。 |
| 避免注释 | 不把显而易见的语句改写成注释，不用注释掩盖混乱实现。不写代码没做什么（范围决定放需求或架构文档，移除原因放提交信息），不写工单号（如 `M-002`、`CR-001`），不写给评审者看的自证，不为不存在的调用方、测试或场景写说明。 |

## 9. 自动化检查与边界

| 目标与范围 | 执行入口与证据 |
| --- | --- |
| 手写 JS/MJS/CJS/TS/TSX 的统一格式；不使用行尾分号，保留必要的 ASI 防护分号 | `.prettierrc.json`、`.editorconfig`；`pnpm format` 先执行 `eslint . --fix`，再执行 `prettier . --write`；`pnpm format:check` 检查排版，`pnpm lint` 检查 ESLint 规则 |
| `apps/mobile/android/app/src` 的 Java 统一排版。Prettier 的续行缩进和换行位置与 Google Java Style 不同，和全项目一致优先 | `.prettierrc.json` 的 `prettier-plugin-java`；入口同上 |
| Java 命名、导入、大括号、Javadoc 和布尔前缀。基于 Checkstyle 的 `google_checks.xml`，差异写在 `checkstyle.xml` 开头：去掉排版规则，空 catch 接受中文原因，`@PluginMethod`（接口说明在 TypeScript 插件定义）和 `@After` 不要求 Javadoc，增加未使用导入和布尔前缀检查 | `apps/mobile/android/checkstyle.xml`、`checkstyle.gradle`；`pnpm lint` 通过 `scripts/android-build.mjs --checkstyle` 运行，只要 JDK，不要 Android SDK；只重新检查改过的文件，违规时非零退出 |
| 全部 Markdown（含 MDX、Prettier 支持的其他 Markdown 扩展名与无扩展名 README）人工维护 | `.prettierignore`；Prettier 排除文件及其中的代码块，编码检查仍由 `pnpm check:text` 覆盖 |
| 手写 JS/TS 的声明、严格比较、动态执行、错误对象与命名导出约束；TS 另检查类型安全、模块边界类型和未处理 Promise | `eslint.config.mjs`；JS 使用语法检查，TS 使用类型感知规则；生成目录不纳入检查 |
| TypeScript 命名遵循语言基线；TSX 允许 PascalCase 组件；外部对象字面量键与导入名保留兼容性 | `eslint.config.mjs`；默认导出仅对当前四个 ESLint、Vite、Capacitor 配置文件豁免 |
| TypeScript 布尔变量、参数和属性使用语义前缀；主体保持 PascalCase，保证整体名称符合 lowerCamelCase | `eslint.config.mjs` 的 `@typescript-eslint/naming-convention`；已在协议中发布的 `blocked`、`cancelRequested`、`dark`、`upload`、`refresh` 保留原名，改协议时再迁移 |
| Android 同一 Maven 模块在运行、测试和构建工具里只解析一个版本 | `apps/mobile/android/dependency-security.json` 的 `singleVersionModules`，由 `settings.gradle` 应用；`pnpm security:android` 发现多版本时失败。这一步要联网并重新解析依赖，不在 `pnpm check` 里 |
| 编码、BOM、换行与严格类型 | `scripts/check-text.mjs`、`tsconfig.base.json`；`pnpm check:text`、`pnpm typecheck` |
| 自动化测试准入 | 默认不新增或扩写，只有维护者在当前任务明确要求时才写；长期测试只守 API、数据结构、持久化、文件安全和核心业务结果 |
| 界面检查 | 通过实际运行、设备操作和浏览器交互，按常规字号及常用移动设备尺寸检查；不验证极端字体大小。交付效果时直接打开可交互的浏览器预览并保留，不提供截图。按钮、文案、DOM、CSS、颜色、布局和快照不进入长期自动化测试 |
| 全量测试 | `pnpm test:all`；用于发布前、大范围高风险改动或维护者明确要求时，`pnpm check` 和普通 CI 不运行它 |
| shared/ui 组件参数不透传样式（禁止 `style`、`className`、`styles`、`classNames` 与剩余属性展开）、主入口不导入 ui 入口 | `eslint.config.mjs` 按 `apps/shared/src/ui` 目录用 `no-restricted-syntax` 禁止这些参数名、继承 `HTMLAttributes`/`ComponentProps`/`CSSProperties`、JSX 展开与剩余参数，并用 `no-restricted-imports` 限制导入；Props 命名导出与 TSDoc 用途说明由人工评审 |
| 文件与目录命名、JavaScript 布尔变量业务命名、文档语义完整性、日志脱敏、事件生命周期及 JS Promise 失败处理 | 由人工评审；JavaScript 无类型信息，ESLint 只检查其 lowerCamelCase 基础命名 |
