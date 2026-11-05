---
doc_type: adr
status: accepted
priority: high
owner: architecture
updated: 2026-11-05
tags: [决策, 界面, 组件库, 共用组件]
related_files: [eslint.config.mjs, apps/shared]
---

# ADR-0002 维持 antd 系列，抽取双端共用渲染

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

accepted。2026-11-01 确定：组件库维持 antd + antd-mobile；与两端交互差异无关的渲染（纯计算、展示组件，乃至整页主体）全部放进 apps/shared，可依赖部分 antd（如 Flex）与图标，两端差异只通过排版参数（方向、尺寸、边距）表达。

## 替代关系

| 被替代 ADR | 原路径 | 原因 |
| --- | --- | --- |
| 无 | 无 | 新决策；修订“两端各自维护完整界面”的约定（architecture/overview.md、requirements/constraints.md、standards/coding-style.md 平台边界） |

## 背景

界面重设计原型 v2（本地 docs/design/ui-redesign-v2/ 不进 Git）让两端同一页面采用相同的信息结构：方向条、差异着色的文件行、计划摘要、阶段条、备份时间线、路径显示等在两端只差尺寸与容器。现有约定要求两端界面各自维护，apps/shared 禁止引入 React、组件库与 DOM，因此这些渲染只能写两份。评估过改用 Base UI 等无样式组件库以便两端共用页面。

## 决策

1. 组件库维持 Windows antd、Android antd-mobile；弹窗、开关、数字框、选择器、提示消息等交互控件继续用库组件。数字框：移动端 antd-mobile Stepper，电脑 antd InputNumber `mode="spinner"`，单位写进标签。
2. 共用部分全部放 apps/shared，分两个入口：
   - 主入口 `@savedata-sync/shared` 保持纯 TypeScript，供电脑主进程、原生协议校验和 node 测试使用：两端差异（diff/only/文件夹含差异）、计划统计、任务阶段映射、备份策略解析、文件类型识别、路径分段、显示格式化、文案。
   - 界面入口 `@savedata-sync/shared/ui`（目录 apps/shared/src/ui）放 React 展示组件与整页主体：游戏封面卡片、文件行与双栏目录、方向条、计划摘要与计划列表、传输详情主体（进度环、阶段条、结论、结果列表）、备份时间线、PathText、FileTypeIcon 等。可依赖 React、@ant-design/icons 和不涉及平台交互的 antd 组件（如 Flex）；禁止 antd-mobile、Electron、Capacitor、Node 与平台接口。
   - 主入口不得导入 ui 入口，ESLint 按目录分别限制；颜色、圆角与字体只在主入口 `preferences/design-tokens.ts` 取值；ui 入口的 `designTheme` 由它生成两端 ConfigProvider 主题，`installDesignTokens` 写出两端样式表共用的 `--ss-*` CSS 变量。
3. 两端差异只通过排版参数传入（方向、尺寸、边距、紧凑程度）。操作入口与平台交互（底部弹层/抽屉/对话框、返回键、系统选择器、确认、提示消息）留在各端，由各端把回调和操作区传给共用主体。
4. 抽取以“与两端交互差异无关”为标准，不为复用而强行统一两端交互。
5. 共用组件的 Props 类型全部命名导出并写明每个参数的用途，不接受、不透传 style、className、styles、classNames 等样式参数；功能相近的一组参数可合并为导出的结构化类型（细则见 standards/coding-style.md“共用界面组件参数”）。

## 原因

- 数字框与多语言需求，现有库都能满足：Stepper 中间默认可输入，InputNumber 支持 spinner 样式，两套库都带 en-US、ja-JP、zh-TW、zh-CN 语言包。
- 换无样式组件库要重做所有交互控件和移动端专用交互（底部弹层、安全区、提示消息），新增依赖还要按 REQ-017 审计。
- 新设计的版式本来就主要靠自定义布局，抽出不依赖组件库的渲染组件即可消除大部分重复。

## 影响

### 正面影响

- 两端同一页面的显示规则只有一份实现，减少两端不一致。
- 组件库、构建、antd lint 与依赖审计保持不变。

### 负面影响

- apps/shared 多了 ui 子路径导出、JSX 编译配置和 React/antd/icons 的 peer 依赖，ESLint 要按目录分别限制。
- 共用组件运行在两套组件库之下，CSS 变量需与两端 ConfigProvider 保持同步；移动端使用 antd 组件时仍要满足触控尺寸。

## 替代方案

| 方案 | 优点 | 缺点 | 结果 |
| --- | --- | --- | --- |
| 改用 Base UI 等无样式组件库，两端共用页面 | 视觉完全自控，页面可一份代码 | 迁移成本高，移动端交互要自建，新增依赖，推翻既有分端约定 | 不采用，必要时以单页试点再议 |
| 统一用 antd，去掉 antd-mobile | 只有一套库 | 触控交互与移动端组件不足 | 不采用 |
| 维持现状，两端完全各写 | 无需调整边界 | 相同渲染写两份，容易再次不一致 | 不采用 |
| 新建独立的 apps/shared-ui 包 | 与纯逻辑包物理隔离 | 多一个工作区包，与统一放 shared 的方向不符 | 不采用，改为 shared 内分入口 |

## 相关文件

- 原型 v2：本地 docs/design/ui-redesign-v2/（不进 Git）
- eslint.config.mjs（apps/shared 与两端的 no-restricted-imports 规则）
- standards/coding-style.md 平台边界、requirements/constraints.md 开发方式、architecture/overview.md 技术选型理由
