---
doc_type: adr
status: accepted
updated: 2026-11-26
tags: [决策, 界面, 组件库, 共用组件]
---

# ADR-0002 两端使用 antd 系列组件库，与交互差异无关的渲染双端共用

## 目录

- [状态](#状态)
- [替代关系](#替代关系)
- [背景](#背景)
- [决策](#决策)
- [原因](#原因)
- [影响](#影响)
  - [正面影响](#正面影响)
  - [负面影响](#负面影响)
- [替代方案](#替代方案)
- [相关文件](#相关文件)

## 状态

accepted。组件库用 antd + antd-mobile；与两端交互差异无关的渲染（纯计算、展示组件，乃至整页主体）全部放进 apps/shared，可依赖部分 antd（如 Flex）与图标，两端差异只通过排版参数（方向、尺寸、边距）表达。

## 替代关系

| 被替代 ADR | 原路径 | 原因 |
| --- | --- | --- |
| 无 | 无 | 新决策；两端界面的边界见 architecture/overview.md、requirements/constraints.md、standards/coding.md 的“模块边界” |

## 背景

两端同一页面的信息结构相同：方向条、差异着色的文件行、计划摘要、阶段条、备份时间线、路径显示等只差尺寸与容器。两端各自维护全部界面时，这些渲染要写两份，容易不一致；两端共用一个根组件、靠 `isMobile` 分支处理差异时，页面、弹层、主题、表单和传输状态混在一起，平台适配器反过来依赖界面包，移动端靠压缩桌面组件适配窄屏，按钮和文字偏小。也评估过用 Base UI 等无样式组件库，让两端共用页面。

## 决策

1. 组件库用 Windows antd、Android antd-mobile；弹窗、开关、数字框、选择器、提示消息等交互控件用库组件。数字框：移动端 antd-mobile Stepper，电脑 antd InputNumber `mode="spinner"`，单位写进标签。
2. 共用部分全部放 apps/shared，分两个入口：
   - 主入口 `@savedata-sync/shared` 只用纯 TypeScript，供桌面端后端、原生协议校验和 node 测试使用：两端差异（diff/only/文件夹含差异）、计划统计、任务阶段映射、备份策略解析、文件类型识别、路径分段、显示格式化、文案。
   - 界面入口 `@savedata-sync/shared/ui`（目录 apps/shared/src/ui）放 React 展示组件与整页主体：游戏封面卡片、文件行与双栏目录、方向条、计划摘要与计划列表、传输详情主体（进度环、阶段条、结论、结果列表）、备份时间线、PathText、FileTypeIcon 等。可依赖 React、@ant-design/icons 和不涉及平台交互的 antd 组件（如 Flex）；禁止 antd-mobile、Tauri、Capacitor、Node 与平台接口。
   - 主入口不得导入 ui 入口，ESLint 按目录分别限制；颜色、圆角与字体只在主入口 `preferences/design-tokens.ts` 取值；ui 入口的 `designTheme` 由它生成两端 ConfigProvider 主题，`installDesignTokens` 写出两端样式表共用的 `--ss-*` CSS 变量。
3. 两端差异只通过排版参数传入（方向、尺寸、边距、紧凑程度）。操作入口与平台交互（底部弹层/抽屉/对话框、返回键、系统选择器、确认、提示消息）留在各端，由各端把回调和操作区传给共用主体。
4. 放进 apps/shared 的渲染以“与两端交互差异无关”为标准，不为复用而强行统一两端交互。
5. 共用组件的 Props 类型全部命名导出并写明每个参数的用途，不接受、不透传 style、className、styles、classNames 等样式参数；功能相近的一组参数可合并为导出的结构化类型（细则见 standards/coding.md 的“模块边界”）。

## 原因

- 数字框与多语言需求两套库都能满足：Stepper 中间默认可输入，InputNumber 支持 spinner 样式，两套库都带 en-US、ja-JP、zh-TW、zh-CN 语言包。
- 换无样式组件库要重做所有交互控件和移动端专用交互（底部弹层、安全区、提示消息），新增依赖还要按 REQ-017 审计。
- 页面版式主要靠自定义布局，不依赖组件库的渲染组件双端共用，就能消除大部分重复。

## 影响

### 正面影响

- 两端同一页面的显示规则只有一份实现，减少两端不一致。
- 不新增组件库，构建、antd lint 和依赖审计只有一套。

### 负面影响

- apps/shared 有 ui 子路径导出、JSX 编译配置和 React/antd/icons 的 peer 依赖，ESLint 要按目录分别限制。
- 共用组件运行在两套组件库之下，CSS 变量需与两端 ConfigProvider 保持同步；移动端使用 antd 组件时仍要满足触控尺寸。

## 替代方案

| 方案 | 优点 | 缺点 | 结果 |
| --- | --- | --- | --- |
| 用 Base UI 等无样式组件库，两端共用页面 | 视觉完全自控，页面可一份代码 | 迁移成本高，移动端交互要自建，新增依赖 | 不采用，必要时以单页试点再议 |
| 两端都用 antd，不用 antd-mobile | 只有一套库 | 触控交互与移动端组件不足 | 不采用 |
| 两端完全各写 | 边界简单 | 相同渲染写两份，容易不一致 | 不采用 |
| 新建独立的 apps/shared-ui 包 | 与纯逻辑包物理隔离 | 多一个工作区包，与统一放 shared 的方向不符 | 不采用，用 shared 内分入口 |

## 相关文件

- 原型 v2：本地 docs/design/ui-redesign-v2/（不进 Git）
- eslint.config.mjs（apps/shared 与两端的 no-restricted-imports 规则）
- standards/coding.md 平台边界、requirements/constraints.md 开发方式、architecture/overview.md 技术选型理由
