---
doc_type: coding-style
status: active
priority: high
owner: development
updated: 2026-10-25
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

## 1. 规范来源

| 来源 | 路径 | 优先级 | 状态 |
| --- | --- | --- | --- |
| 自动化配置 | `.editorconfig`、`.gitattributes`、`.prettierrc.json`、`eslint.config.mjs`、`tsconfig.base.json`、`package.json` | P0 | active |
| Skill 通用规范入口 | `references/company-standards/language-baseline.md` | P1 | active |
| Skill 通用编码规则 | `references/company-standards/common-rules.md` | P1 | active |
| 项目记忆 | 本文件 | P2 | active |
| 现有代码风格 | `apps/`、`packages/shared/`、`scripts/` | P3 | active |

## 2. 维护边界

| 类型 | 写入位置 | 规则 |
| --- | --- | --- |
| 通用语言规范基线 | Skill 自身 `references/company-standards/` | 不在项目模板中私自修改 |
| 项目级覆盖和差异 | 本文件或同目录规范文件 | 记录差异原因、适用范围和生效条件 |
| 自动化格式规则 | 项目配置文件 | 以真实配置为准 |

## 3. 命名规范

| 类型 | 规则 | 示例 |
| --- | --- | --- |
| 手写 TS/JS 与 React | 遵循语言基线；React 组件 PascalCase，普通脚本与模块 kebab-case，优先命名导出 | `App.tsx`、`toolchain-policy.mjs` |
| 框架约定 | Vite、Capacitor、ESLint 配置按框架要求默认导出 | `vite.config.ts`、`capacitor.config.ts` |

## 4. 目录与模块规范

| 规则 | 原因 |
| --- | --- |
| 平台边界 | `packages/shared` 不引入 Node、Electron 或 Android 平台接口；平台能力留在各应用适配层 |
| 原生生成工程 | Android 模板保留原生工具风格，不用 Prettier 重写；手写改动仍需检查 UTF-8 与换行 |
| 检查入口 | `pnpm check` 执行文本、格式、lint、类型、基础设施测试和双端构建；`security:check` / `security:android` 分别审计 Node 工具链及 Maven |
| 版本控制边界 | 忽略清单以 `.gitignore` 为准，生成产物与临时报告不进入 Git |

## 5. 错误处理与日志

| 场景 | 规则 |
| --- | --- |
| CLI 或网络检查失败 | 显式非零退出，不把下载、解析或审计失败当作成功 |
| Electron 异步启动 | 捕获加载/初始化错误，保留原始错误上下文；preload 仅暴露明确的只读边界 |
| 工具日志 | 不输出密钥、代理凭据或其他敏感配置；完整命令历史不写入记忆 |

## 6. 版权信息

私有项目默认遵循 Skill 公司通用编码规则中的公司版权主体。这里只记录项目级差异；没有差异时保持“遵循公司基线”。

| 场景 | 规则 |
| --- | --- |
| 默认规则 | 遵循公司基线 |
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
