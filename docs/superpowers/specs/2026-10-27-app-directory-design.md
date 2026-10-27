# 双端独立界面与目录重组设计

日期：2026-10-27。状态：已实施，工程、浏览器和真机验收通过。

## 目录

- [设计依据](#设计依据)
- [现状与问题](#现状与问题)
- [目标目录](#目标目录)
- [文件归属与依赖](#文件归属与依赖)
- [移动端操作面板](#移动端操作面板)
- [迁移顺序](#迁移顺序)
- [检查与验收](#检查与验收)
- [本方案采用的具体选择](#本方案采用的具体选择)

## 设计依据

用户已明确的方向：

1. 桌面和移动端各自实现界面，放弃共用界面。
2. 原根目录 `packages` 的代码收进 `apps`。
3. `apps` 下分成 `mobile`、`desktop`、`shared`。
4. 移动端现有部分按钮太小、难以点击；游戏操作面板应参考本次图 2 的尺寸和布局。此前页面原型也采用了这种布局。
5. 移动端优先使用 antd-mobile，也可以使用 antd；使用桌面组件时同样考虑触控尺寸和操作方式。

沿用 Electron + React + antd 桌面端、Capacitor + React + antd-mobile 移动端，以及现有 Android Java 原生能力。已有技术选择见 `.project-memory/architecture/overview.md`；两端组件库原本就计划分别使用。

这次重组解决界面归属、触控体验和维护问题。覆盖、镜像删除、备份恢复等业务仍按已有里程碑接入，目录迁移不改变现有可用功能。

## 现状与问题

| 当前代码 | 检查到的事实 | 影响 |
| --- | --- | --- |
| `apps/mobile/src/App.tsx`、`apps/desktop/src/renderer/src/App.tsx` | 都加载 `@savedata-sync/ui` 的 `LibraryApp` | 两端应用入口主要负责注入适配器，页面实际归共享包管理 |
| `packages/ui/src/LibraryApp.tsx` | 同时持有页面、弹层、主题、表单、轮询、设备和传输状态，通过 `isMobile` 分支处理平台差异 | 改某端交互时要同时检查另一端，界面状态与业务操作交织 |
| `packages/ui/src/components/GameMenu.tsx` | 手机使用 antd-mobile `Popup`，桌面使用 antd `Modal` | 移动弹层的外壳已经使用移动组件库 |
| `packages/ui/src/components/GameActions.tsx` | 内容仍是 antd `Button` 和纵向 `Space`，五项动作都整行排列 | 共用内容没有保留原型的主操作卡片和双列次级操作 |
| `packages/ui/src/components/LibraryShell.tsx` | 同时挂载两套组件库的主题/语言入口 | 两端界面依赖和主题配置集中在同一个组件中 |
| `packages/ui/src/style.css` | 移动工具栏文字设为 12px，目录时间为 9px，表格单元格统一 7px 内边距 | 手机通过进一步压缩桌面样式适配窄屏，触控和阅读空间不足 |
| `packages/ui/src/DirectoryPane.tsx` | 两端共用 antd 小号表格、上一级和刷新按钮 | 文件区的移动操作也需要单独设计 |
| `packages/ui/src/api.ts`、两端 `library-adapter.ts` | 业务接口、任务判断和结果解包从 UI 包导出，平台适配器反过来依赖 UI 包 | 即使拆开页面，仍需把这些共用规则和类型移到合适的位置 |
| 两端旧 `DirectoryPanel.tsx`、`TaskPanel.tsx` 等 | 当前正式入口和源码引用检索未发现这些旧验证组件被使用 | 新旧界面并存，容易找错修改入口；迁移时应逐个核实用途 |

本次本地 antd 使用扫描覆盖共享 UI 的 20 个文件，发现 19 类 antd 组件、62 处组件导入。源码中 antd-mobile 主要用于外壳导航、主题入口和游戏弹层。移动端已经依赖 `antd-mobile`，但正式页面的大部分内容仍采用桌面组件。

此前原型 `docs/design/ui-before-wp008/prototype.js` 的 `renderSheet()` 使用一块整行“传输存档”卡片和四块双列操作卡片；`prototype.css` 为主卡片设置上下 22px 内边距，为次级卡片设置上下 20px 内边距，并有顶部提示条。现实现没有保留这些结构。

因此，按钮偏小与桌面组件的默认密度、现有 CSS 和布局选择都有关系。目录位置本身不会决定按钮大小；新的目录归属让移动端能独立修正这些问题。

## 目标目录

```text
apps/
├─ mobile/
│  ├─ src/
│  │  ├─ app/                    # 移动入口、导航、主题、弹层协调、返回键处理
│  │  ├─ features/
│  │  │  ├─ games/               # 游戏页、GameActionSheet、游戏目录设置、导入
│  │  │  ├─ devices/             # 设备页、连接和设备编辑
│  │  │  ├─ transfer/            # 双列文件、预览、任务进度与结果
│  │  │  ├─ backup/              # 备份恢复入口及后续页面
│  │  │  └─ settings/            # 设置页
│  │  ├─ components/             # 本端跨功能使用的组件
│  │  ├─ platform/               # Capacitor 桥、SAF、原生传输、持久化适配
│  │  ├─ styles/                 # 移动主题、尺寸与全局样式
│  │  └─ main.tsx
│  ├─ android/                   # 保留现有 Java 工程与构建位置
│  ├─ test/
│  └─ package.json
├─ desktop/
│  ├─ src/
│  │  ├─ main/                   # 保留现有文件、HTTP、存储和传输实现
│  │  ├─ preload/                # Electron 受限桥入口
│  │  ├─ bridge/                 # 桌面跨进程接口、通道与数据校验
│  │  └─ renderer/
│  │     ├─ index.html
│  │     └─ src/
│  │        ├─ app/              # 桌面入口、侧边导航、主题与弹窗协调
│  │        ├─ features/
│  │        │  ├─ games/         # 游戏页、GameActionDialog、游戏目录设置、导入
│  │        │  ├─ devices/
│  │        │  ├─ transfer/
│  │        │  ├─ backup/
│  │        │  └─ settings/
│  │        ├─ components/       # 本端跨功能使用的组件
│  │        ├─ platform/         # Renderer 对桌面受限桥的适配
│  │        ├─ styles/           # 桌面主题、尺寸与全局样式
│  │        └─ main.tsx
│  ├─ test/
│  └─ package.json
└─ shared/
   ├─ src/
   │  ├─ protocol/               # 目录/设备 DTO、HTTP 常量、批量协议与守卫
   │  ├─ library/                # 游戏/设备配置、关联及相关校验
   │  ├─ transfer/               # 任务判断、传输预检等两端业务规则
   │  ├─ validation/             # 内部纯数据校验辅助
   │  ├─ result.ts               # 共用结果解包
   │  └─ index.ts                # 公开导出
   ├─ test/
   ├─ tsconfig.json
   ├─ README.md
   └─ package.json

docs/                             # 需求、原型、设计和开发文档
scripts/                          # 仓库级构建、检查与安全审计
```

功能目录内让页面、专用组件、Hook 和样式放在一起，例如 `mobile/src/features/games/GameActionSheet.tsx` 和对应样式。只有同一端的多个功能都用到的组件，才放该端 `components`。目录随实际文件创建，避免预建大量空目录。

工作区改为：

```yaml
packages:
  - apps/mobile
  - apps/desktop
  - apps/shared
```

`onlyBuiltDependencies` 和 `overrides` 保留现有内容。`apps/shared` 仍是独立的 pnpm 包，包名沿用 `@savedata-sync/shared`，两端继续通过包名导入。

## 文件归属与依赖

| 当前内容 | 目标归属 | 迁移方式 |
| --- | --- | --- |
| `packages/shared/src/contracts.ts`、`protocol.ts`、`validation.ts`、`batch-*.ts` | `apps/shared/src/protocol/` | 保留协议字段、常量、守卫和语义，调整内部路径 |
| `packages/shared/src/library.ts` | `apps/shared/src/library/` | 保留配置及交换数据结构与相关纯函数 |
| `packages/shared/src/data-validation.ts` | `apps/shared/src/validation/` | 继续作为内部辅助；避免借重组增加无关公共 API |
| `packages/shared/test` 与说明 | `apps/shared/test` 与说明 | 保留现有用例，更新源码路径和文档链接 |
| `packages/ui/src/api.ts` | `apps/shared` 及两端本地类型 | 共用任务数据、任务活动判断、结果解包归 shared；界面快照和平台适配器各端维护；展示格式先留本端 |
| `LibraryApp.tsx` 中的游戏关联、导入与传输预检规则 | `apps/shared/src/library`、`transfer` | 提取纯函数，返回数据或问题结果；由各端决定提示、确认与跳页 |
| `LibraryApp.tsx` 中的导航、弹层、表单和界面状态 | 两端各自 `app`、`features` | 各端独立实现，不保留一个共同根组件 |
| `pages/*`、`components/*`、`DirectoryPane.tsx`、`TaskView.tsx`、`style.css` | 两端各自 `features`、`components`、`styles` | 桌面沿用合适的 antd 组件；移动端按 antd-mobile 和原型重新实现 |
| 桌面根级 `directory-bridge.ts`、`service-bridge.ts`、`library-bridge.ts` | `apps/desktop/src/bridge/` | 桌面内部接口继续留在桌面包；同步 main、preload、renderer、测试的导入 |
| 移动 SAF/传输桥与 `library-adapter.ts` | `apps/mobile/src/platform/` | 保留原生行为；UI 相关类型改为本端定义或 shared 业务类型 |
| 移动 `back-button.ts`、`system-theme.ts` | `apps/mobile/src/app/` | Android 返回顺序和主题生命周期由移动应用管理 |
| 桌面 `library-adapter.ts` | `apps/desktop/src/renderer/src/platform/` | 继续通过有限桥调用原生能力 |
| 两端旧验证组件与相关辅助 | 核实后迁移或删除 | 核对入口、导出和测试引用；有正式用途的保留，无用途的随界面迁移清理 |

依赖方向：`mobile → shared`、`desktop → shared`。两端通过现有 HTTP 协议交换数据，不互相导入源码。`shared` 使用纯 TypeScript，包含可复用的类型和规则；React、antd、antd-mobile、DOM、Electron、Capacitor、存储和文件操作留在所属应用。

两端独立维护页面状态和 Hook。诸如弹层是否打开、选中哪个标签、表单草稿、返回栈、页面可见时轮询等，都跟随本端界面。任务仍由现有原生层持有，切页或关闭弹层不会取消传输。共用的任务活动判断和传输预检规则由 shared 提供，避免两套业务判定逐渐分歧。

移除通用 `UiAdapter` 后，桌面接口只提供实际支持的服务、授权和任务操作，移动接口提供连接、SAF 和发起传输等能力。当前桌面 `connect()`、`start()` 的拒绝实现不必为了满足共用 UI 接口继续保留。原生层继续执行真实权限、会话和文件安全校验。

依赖由各包直接声明：桌面声明 antd，移动优先声明并使用 antd-mobile；移动端实际用到 antd 时保留直接依赖，同时设置和检查触控尺寸。图标依各端实际使用分别声明。桌面通过独立入口摆脱对 antd-mobile 的间接依赖。React 各端分别声明，shared 保持纯 TypeScript。

## 移动端操作面板

游戏操作面板按图 2 和已有原型的布局关系实现，保留本应用的五项动作：

1. 底部弹层顶部放提示条、游戏名称和关闭入口。
2. “传输存档”为整行主操作卡片，左图标、中文字、右侧进入提示。
3. “目录设置”“备份与恢复”“本次传输”“移除游戏”为两列卡片，移除操作用危险色。
4. 整张卡片可点击。内容较高时弹层内滚动，底部留系统手势区域。

图 2 的其他游戏启动器功能不加入本应用。沿用本项目暗色纯黑背景与跟随系统主题的要求，以主题色、卡片层次和间距体现相同布局。

建议尺寸作为实现起点，具体值由实际显示验证后调整：

| 元素 | 建议起点 |
| --- | --- |
| 普通按钮、独立图标按钮、目录上一级/刷新 | 至少 48 × 48 CSS px 可点击区域 |
| 主操作卡片 | 最小高度 64 CSS px |
| 双列次级卡片 | 最小高度 64 CSS px |
| 操作文字 | 16 CSS px，按系统字号变化留出换行空间 |
| 卡片间距 | 12 CSS px |

Android 官方建议触控区域至少 48 × 48dp，见[无障碍控件尺寸说明](https://developer.android.com/guide/topics/ui/accessibility/apps#use-large-simple)。本方案在 WebView 使用 CSS px 设置起点，并已在目标真机结合视口配置、屏幕缩放和系统字体检查；点击区域不能直接按截图物理像素换算。移动端使用 antd-mobile 后也明确设置和检查点击区域。

两端文件始终并列、每列独立进入目录、文件元数据直接显示、时间精确到分钟等已有要求继续保留。移动端单独实现每列的条目和工具栏，完整显示时间，不再靠将时间缩到 9px 或使用桌面小号按钮挤空间。

## 迁移顺序

1. 把 `packages/shared` 移到 `apps/shared`，调整工作区、内部分类和所有直接文件路径；保留包名与公共导出。协议数据与持久化格式维持现有语义。
2. 从 UI 包中提取两端都需要的纯数据、任务判断和业务校验到 `apps/shared`；把原生适配器改成依赖 shared 或本端类型。
3. 建立桌面独立应用入口，把共享包中的桌面页面迁入桌面功能目录，配置桌面主题；此时移动端可暂用旧 UI 包完成过渡。
4. 独立实现移动端页面、导航和弹层，优先完成游戏操作面板与双列文件的触控尺寸；移动端入口切换后核对返回键和后台恢复。
5. 两端都脱离旧 UI 后，移除 `@savedata-sync/ui`、旧共用样式和已核实无用途的验证组件。同步清除根 `packages`，更新锁文件、构建配置、README 和代码地图。
6. 最后核对桌面桥目录、旧路径引用、依赖边界和真实应用显示。迁移中的每个可运行阶段都保留恢复点；出现问题可退回上一阶段，保留用户数据。

第一阶段的最终工作区清单需在过渡期间暂时加入仍在使用的 `packages/ui`，待第五步移除，保证中间阶段可以构建。同步修改 Electron main/preload 的 shared 内联配置时继续使用原包名。

迁移不修改应用 ID、HTTP 线格式、Android 包名、已有配置 schema、桌面配置位置或移动端 `savedata-sync:library:1` 存储键。原生传输和发布实现保留，减少界面重组对存档操作的影响。

## 检查与验收

- 结构检查：最终源码集中在 `apps/mobile`、`apps/desktop`、`apps/shared`；两端无相互源码导入，shared 无组件库和平台依赖；正式入口已摆脱 `@savedata-sync/ui`。
- 工程检查：完成迁移后运行 `pnpm check`、现有受影响 shared/移动桥/桌面 IPC 套件和 `pnpm android:build`，并核对 Electron 构建产物。目录移动不新增界面自动化测试。
- 移动检查：已按常规字号和常用手机尺寸在目标真机检查游戏页、操作面板、目录设置、传输双列、预览与任务页，并核对长名称、暗色主题、弹层滚动、底部手势区和截图对应界面。按用户要求，未验证极端字体大小。
- 交互检查：确认实际点击区域和相邻控件间距；Android 返回依次关闭当前最上层弹层或返回页面，在游戏根页交给现有退出行为。具体弹层优先级沿用当前已实现顺序，迁移不撤掉返回监听。
- 业务检查：现有游戏/设备配置可读取；保存失败保留编辑内容；切换设备或目录清除旧选择；页面切换、进入后台和返回后仍可查询当前原生任务及其结果。
- 桌面检查：侧边导航、居中弹窗、表格与服务操作保留适合鼠标键盘的布局，移动尺寸调整不会改变桌面样式。

本轮已完成目录迁移、两端独立界面与移动触控调整，`pnpm check`、56 项既有共享/平台测试和 Android 构建通过；分项与整体独立代码审查通过。浏览器用临时示例适配器加载真实页面，检查了常规字号下的移动操作面板、双列文件和桌面布局；原生真机与跨端操作也已通过验收。

## 本方案采用的具体选择

用户已确定独立界面与 `apps/mobile`、`apps/desktop`、`apps/shared`。以下是本设计给出的实施建议：

- 保留包名 `@savedata-sync/shared`，减少目录迁移带来的无关导入变化。
- shared 保持纯 TypeScript；界面 Hook 和应用状态先各端维护，不再建立共用 UI 或 React 状态包。
- 各端按功能组织页面；桌面保留现有 `renderer/src`、原生主进程和 Android 保留现有 Java 工程，避免同时改动构建入口和原生布局。
- 先恢复已有操作面板的卡片布局，再按真机结果调整建议尺寸；触控区域覆盖移动端目录工具栏等其余交互。
- 按可构建阶段迁移，沿用现有数据与原生能力。
