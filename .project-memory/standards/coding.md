---
doc_type: standards-coding
status: active
updated: 2026-11-27
tags: [编码规范]
---

# 编码约定

`coding-standards` 技能的项目取值和差异。通用规则见该技能，这里不重复。

## 目录

- [取值](#取值)
- [差异](#差异)
  - [格式与工具](#格式与工具)
  - [命名](#命名)
  - [模块边界](#模块边界)
  - [React 与界面代码](#react-与界面代码)
  - [交付与协作](#交付与协作)

## 取值

| 项目 | 取值 |
| --- | --- |
| 语言 | TypeScript（共享包、桌面端、移动端网页层）；Android 原生用 Java，不引入 Kotlin；脚本用 `.mjs` |
| 注释语言 | 中文；代码标识、API 名称和工具指令保留原文 |
| 工具配置 | `.editorconfig`、`.gitattributes`、`.prettierrc.json`、`.prettierignore`、`eslint.config.mjs`、`tsconfig.base.json`、`apps/mobile/android/checkstyle.xml` |
| 检查入口 | `pnpm check` 依次运行类型检查、ESLint、Checkstyle（需要 JDK）、Clippy、两端构建、依赖版本写法、文本编码、Prettier 和 rustfmt，某一步失败即停止，文本编码和格式检查放最后。`pnpm format` 自动修复 |
| 许可证和作者署名 | AGPL-3.0，见根目录 `LICENSE`；源码不加版权头，不新增版权主体；第三方版权与许可声明保留原文 |
| 界面约定 | 设计变量、组件选用、尺寸和反馈规则见[界面约定](../development/ui-conventions.md) |

## 差异

### 格式与工具

| 规则 | 原因 | 适用范围 |
| --- | --- | --- |
| 不写行尾分号，保留必要的 ASI 防护分号 | `.prettierrc.json` 的设置 | JS、TS |
| Java 也由 Prettier（`prettier-plugin-java`）排版，续行缩进和换行位置和 Google Java Style 不同 | 全项目排版一致优先 | `apps/mobile/android/app/src` 的 Java |
| Checkstyle 基于 `google_checks.xml`，去掉排版规则；空 catch 接受中文原因；`@PluginMethod` 和 `@After` 不要求 Javadoc；另加未使用导入和布尔前缀检查。差异写在 `checkstyle.xml` 开头 | 排版交给 Prettier；插件方法的接口说明写在 TypeScript 网页接口 `*Api` 上 | Android Java |
| `apps/mobile/android/` 下除 `app/src` 的 Java 外保留原生工具生成的风格，不用 Prettier 重写 | Capacitor 和 Gradle 生成的文件，改格式会和上游模板对不上 | Android 原生工程 |
| Markdown 不由 Prettier 排版，人工维护；编码和换行仍由 `scripts/check-text.mjs` 检查 | Prettier 会改写表格和中文换行 | 全部 Markdown |
| 默认导出只用于框架要求的配置文件 | 框架按默认导出读取配置 | `eslint.config.mjs`、`vite.config.ts`、`vite.sidecar.config.ts`、`capacitor.config.ts` |
| 文档注释由 `jsdoc/require-jsdoc`（`publicOnly`）检查；名称以 `NativePlugin` 结尾的原生插件接口，方法文档写在同文件网页接口的同名方法上 | 两个接口方法一一对应，只写一处 | TypeScript |
| eslint-plugin-react 的 React 版本在 `eslint.config.mjs` 里写死为 `18.3`，和 apps 的 react 依赖一致；升级 React 时一起改 | ESLint 10 去掉了 `context.getFilename`，插件的 `detect` 会报错 | TSX |
| `pnpm-workspace.yaml` 的 `peerDependencyRules` 允许 eslint-plugin-react 7.37 搭配 ESLint 10；插件发布支持 ESLint 10 的版本后删掉这条 | 插件的 peer 范围还停在 ESLint 9，项目用到的规则在 ESLint 10 上能正常运行 | 依赖 |
| npm 依赖的版本写法按所在字段决定，由 `scripts/check-dependency-specs.mjs`（`pnpm check` 运行）检查：`dependencies` 和 `peerDependencies` 会打包给用户，写精确版本；`devDependencies` 是开发工具，写 `^` 范围。例外：`@capacitor/cli` 写精确版本；`apps/shared` 为开发安装的 peer 依赖和 peer 声明写法相同。几个应用共用的运行时库（antd、`@ant-design/icons`、react、react-dom、`qrcode.react`）的版本只写在 `pnpm-workspace.yaml` 的 `catalog`（也写精确版本），各 `package.json` 写 `catalog:`。`@types/node` 停在 `^22`、`@types/react*` 停在 `^18`，跟随内嵌 Node 和 React 的主版本。`.npmrc` 的 `save-exact` 让 `pnpm add` 默认写精确版本，加开发工具时写 `pnpm add -D <包>@^x.y.z`。`pnpm-workspace.yaml` 的 `minimumReleaseAge` 让解析只用发布满 3 天的版本，等不了的安全修复临时加进 `minimumReleaseAgeExclude`，升级后删掉 | 实际版本始终由 `pnpm-lock.yaml` 固定，CI 用 `--frozen-lockfile`，写法只决定 `pnpm update` 能动哪些包。开发工具出问题由 `pnpm check` 发现，所以让 `pnpm update` 直接升级；运行时依赖升级后要按[依赖表](../architecture/dependencies.md)复测，`pnpm check` 发现不了，只能有意识地逐个升级。按字段判断不用维护包名清单，新加的依赖放对字段就自动适用；Capacitor 三个包要同版本整组升级；catalog 让两端用同一版本 | 根和各应用的 `package.json`、`pnpm-workspace.yaml` |
| `@tauri-apps/api` 和 `tauri` crate 的主版本、小版本必须一致，升级时改 `@tauri-apps/api` 的精确版本并一起跑 `cargo update` | Tauri CLI 打包时检查两者版本，不一致直接报错 | 桌面端 |
| Android 同一 Maven 模块在运行、测试和构建工具里只解析一个版本，版本写在 `dependency-security.json` 的 `singleVersionModules` | 多版本时安全审计和运行结果对不上 | Android 依赖；`pnpm security:android` 检查 |

### 命名

| 规则 | 原因 | 适用范围 |
| --- | --- | --- |
| React 组件文件 PascalCase，其余模块和脚本 kebab-case | 现有代码的约定 | TS、TSX、MJS |
| 布尔名由 `@typescript-eslint/naming-convention` 检查前缀，前缀后的主体用 PascalCase；协议、存储和插件参数的字段同样遵守，没有历史字段例外 | 所有受检字段统一命名；1.0 起修改已有落盘格式须按 [ADR-0006](../decisions/ADR-0006-stable-release-compatibility.md) 写迁移，修改协议字段须维护者同意并在次版本同步更新两端 | TypeScript；Java 由 Checkstyle 检查 |
| JSX 里 `checked`、`disabled`、`hidden`、`open`、`readOnly`、`required` 不加前缀 | 和 DOM 属性、组件库 props 同名，改名就传不进去 | TSX |
| 未使用的参数必须以 `_` 开头 | `tsconfig` 开启了 `noUnusedParameters`，回调签名里占位的参数要显式标出 | TypeScript |
| 对象字面量的属性名和导入名不检查命名 | 要和外部接口、第三方库的字段一致 | TypeScript |
| JavaScript 只检查 lowerCamelCase 基础命名，布尔前缀靠人工评审 | 没有类型信息，规则判断不了布尔值 | JS、MJS |

### 模块边界

| 规则 | 原因 | 适用范围 |
| --- | --- | --- |
| 与两端交互差异无关的计算和渲染放 `apps/shared`。主入口 `@savedata-sync/shared` 只用纯 TypeScript，不引入 React、组件库、DOM、Node、Tauri 或 Android 接口；界面入口 `@savedata-sync/shared/ui` 可以用 React、`@ant-design/icons` 和不涉及平台交互的 antd 组件，不用 antd-mobile、react-dom、Tauri、Capacitor 和 Node。主入口不导入 ui 入口 | 桌面端 sidecar 和 node 测试只加载主入口；决定见 [ADR-0002](../decisions/ADR-0002-ui-library-and-shared-rendering.md) | `apps/shared`；`eslint.config.mjs` 的 `no-restricted-imports` 检查 |
| ui 入口用独立的 `src/ui/tsconfig.json`（含 DOM），主入口的 tsconfig 排除它 | 主入口不能用到 DOM 类型 | `apps/shared` |
| 弹层、抽屉、返回键、系统选择器、确认、提示消息等平台交互，以及页面状态和 Hook 留在各端；平台能力留在各应用的适配层 | 两端交互方式不同 | `apps/desktop`、`apps/mobile` |
| 桌面端和移动端互不导入对方的源码 | 两端只通过共享包共用代码 | `eslint.config.mjs` 检查 |
| shared/ui 组件的 Props 类型全部命名导出，每个参数写 TSDoc 用途说明（名称已经说清楚的也写）；不接受、不透传 `style`、`className`、`styles`、`classNames` 和剩余属性。两端差异只通过含义明确的参数表达（方向、尺寸、边距档位、紧凑程度等），相近的一组参数可以合并成一个导出的结构化类型 | 共用组件接口要可读，两端只能按约定的方式变化 | `apps/shared/src/ui`；样式参数和展开由 `no-restricted-syntax` 检查，TSDoc 由人工评审 |

### React 与界面代码

| 规则 | 原因 | 适用范围 |
| --- | --- | --- |
| 所有提示消息走各端 `app/app-message.ts` 的 `useAppMessage`，别处不直接用 antd 的 `message` | 重开退场中的同 key 提示时计时不会重启，提示会一直不消失；统一入口才能保证每条用新 key | 两端界面；ESLint 检查 |
| 日期和时间用 `apps/shared/src/i18n/format.ts` 的固定格式（`yy-MM-dd HH:mm`、`MM-dd`、`HH:mm`），不用 `Intl.DateTimeFormat`、`toLocaleString` 等按区域格式化的接口；名称排序用 `compareNames`、`compareNamePaths`（固定英文规则的 `Intl.Collator`）。列表按名称、大小、时间排序显示时在界面层排，后端只保留协议的规范顺序、备份保留和地址优先级这类不为显示的排序 | 界面格式不随系统区域变化；桌面端后端内嵌的 Node 只带英文区域数据，按区域格式化在后端会静默退回英文 | 两端界面、`apps/shared`、桌面端 sidecar |
| 条件渲染写成 `cond ? <X /> : null`，不用 `cond && <X />`（左侧是比较表达式时除外） | `0` 或空字符串会被渲染出来；`react/jsx-no-leaked-render` 检查 | TSX |
| 传给 props 的渲染函数（antd 的 `itemRender`、`footer` 等）可以内联定义 | 组件直接调用这些函数，不会当作组件挂载；`react/no-unstable-nested-components` 设了 `allowAsProps` | TSX |
| 按请求键重置的状态在渲染时用“上一次的键”比较后调整，不在 effect 里 `setState`；回调要读最新值时用 ref，并在 `useLayoutEffect` 里同步 | react-hooks 7 的 `set-state-in-effect`、`refs` 规则 | TSX |

### 交付与协作

| 规则 | 原因 | 适用范围 |
| --- | --- | --- |
| 日常只编译桌面运行资源，不生成免安装版；打包要维护者明确要求 | 打包慢，产物不进 Git | Windows 交付 |
| 界面原型只留在本地（`docs/design/`、`.reports/`，都已被 Git 忽略） | 原型不是当前实现，提交后容易被当成规格 | 设计稿 |
