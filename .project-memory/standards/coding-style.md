---
doc_type: coding-style
status: active
priority: high
owner: development
updated: 2026-10-26
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
| 自动化配置 | `.editorconfig`、`.gitattributes`、`.prettierrc.json`、`.prettierignore`、`eslint.config.mjs`、`tsconfig.base.json`、`package.json` | P0 | active |
| Skill 通用规范入口 | `references/general-standards/language-baseline.md` | P1 | active |
| Skill 通用编码规则 | `references/general-standards/common-rules.md` | P1 | active |
| 项目记忆 | 本文件 | P2 | active |
| 现有代码风格 | `apps/`、`packages/shared/`、`scripts/` | P3 | active |

## 2. 维护边界

| 类型 | 写入位置 | 规则 |
| --- | --- | --- |
| 通用语言规范基线 | Skill 自身 `references/general-standards/` | 不在项目模板中私自修改 |
| 项目级覆盖和差异 | 本文件或同目录规范文件 | 记录差异原因、适用范围和生效条件 |
| 自动化格式规则 | `.prettierrc.json`、`.editorconfig` | 格式只维护一份；ESLint 通过 `eslint-plugin-prettier/recommended` 读取 Prettier 配置并关闭冲突规则 |

## 3. 命名规范

| 类型 | 规则 | 示例 |
| --- | --- | --- |
| 手写 TS/JS 与 React | 遵循语言基线；React 组件 PascalCase，普通脚本与模块 kebab-case，优先命名导出 | `App.tsx`、`toolchain-policy.mjs` |
| 框架约定 | Vite、Capacitor、ESLint 配置按框架要求默认导出 | `vite.config.ts`、`capacitor.config.ts` |

## 4. 目录与模块规范

| 规则 | 原因 |
| --- | --- |
| Agent 开发准入 | 全仓库门槛以根目录 `AGENTS.md` 为准；应用细则在 `apps/AGENTS.md`，由根文件要求在修改应用前主动读取；开发必须具备并读取 `antd` skill |
| 平台边界 | `packages/shared` 不引入 Node、Electron 或 Android 平台接口；平台能力留在各应用适配层 |
| 原生生成工程 | Android 模板保留原生工具风格，不用 Prettier 重写；手写改动仍需检查 UTF-8 与换行 |
| Android Java | 用户同意沿用 Java；通用基线无专属 Java 文件，适用通用编码规则、现有 Android 风格及官方 Java 约定。原生代码用 javac、Android lint、单元/仪器测试验证，不为本包引入 Kotlin 插件 |
| 检查入口 | `pnpm check` 执行文本、格式、lint、类型、基础设施测试和双端构建；`security:check` / `security:android` 分别审计 Node 工具链及 Maven |
| 版本控制边界 | 忽略清单以 `.gitignore` 为准，生成产物与临时报告不进入 Git |

## 5. 错误处理与日志

| 场景 | 规则 |
| --- | --- |
| CLI 或网络检查失败 | 显式非零退出，不把下载、解析或审计失败当作成功 |
| Electron 异步启动 | 捕获加载/初始化错误，保留原始错误上下文；preload 仅暴露明确的只读边界 |
| 工具日志 | 不输出密钥、代理凭据或其他敏感配置；完整命令历史不写入记忆 |

## 6. 版权信息

版权信息以项目实际作者、现有许可证和用户明确要求为准；Skill 不预设版权归属。尚未明确的署名信息保持待确认。

| 场景 | 规则 |
| --- | --- |
| 默认规则 | 遵循项目现有许可证和明确的作者署名；未明确时不新增版权主体 |
| 项目差异 | 待补充 |

## 7. 接口与函数说明

| 对象 | 需要说明 |
| --- | --- |
| 对外 API / CLI 命令 | 输入参数、输出结构、错误码或异常、兼容性约束、示例位置。 |
| 公开函数 / 模块接口 | 参数含义、返回值、副作用、错误行为、调用前置条件。 |
| 配置项 / 数据结构 | 字段含义、默认值、取值范围、迁移或兼容性影响。 |
| FFI / 跨语言边界 | 所有权、生命周期、线程安全、内存释放责任、异常或错误码传递方式。 |

## 8. 代码注释

| 场景 | 规则 |
| --- | --- |
| 必要注释 | 解释业务规则、边界条件、安全/隐私约束、非显然算法和兼容性取舍。 |
| 避免注释 | 不把显而易见的语句改写成注释，不用注释掩盖混乱实现。 |

## 9. 自动化检查与边界

| 目标与范围 | 执行入口与证据 |
| --- | --- |
| 手写 JS/MJS/CJS/TS/TSX 的统一格式；按用户要求不使用行尾分号，保留必要的 ASI 防护分号 | `.prettierrc.json`、`.editorconfig`；`pnpm format`、`pnpm format:check`、`pnpm lint` 与 `eslint --fix` 共用配置 |
| 全部 Markdown（含 MDX、Prettier 支持的其他 Markdown 扩展名与无扩展名 README）人工维护 | `.prettierignore`；Prettier 排除文件及其中的代码块，编码检查仍由 `pnpm check:text` 覆盖 |
| 手写 JS/TS 的声明、严格比较、动态执行、错误对象与命名导出约束；TS 另检查类型安全、模块边界类型和未处理 Promise | `eslint.config.mjs`；JS 使用语法检查，TS 使用类型感知规则；生成目录不纳入检查 |
| TypeScript 命名遵循语言基线；TSX 允许 PascalCase 组件；外部对象字面量键与导入名保留兼容性 | `eslint.config.mjs`；默认导出仅对当前四个 ESLint、Vite、Capacitor 配置文件豁免 |
| 编码、BOM、换行与严格类型 | `scripts/check-text.mjs`、`tsconfig.base.json`；`pnpm check:text`、`pnpm typecheck` |
| 文件与目录命名、布尔变量业务命名、文档语义完整性、日志脱敏、事件生命周期及 JS Promise 失败处理 | 仍需人工评审；当前 ESLint 配置不能完整验证这些语义 |
