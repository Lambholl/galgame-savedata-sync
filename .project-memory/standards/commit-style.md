---
doc_type: commit-style
status: active
priority: low
owner: project
updated: 2026-10-26
tags: [提交规范]
related_files: []
---

# 提交规范

## 目录

- [提交规范](#提交规范)
  - [目录](#目录)
  - [1. 基本规则](#1-基本规则)
  - [2. 提交策略](#2-提交策略)
  - [3. 提交格式](#3-提交格式)
    - [类型（type）定义](#类型type定义)
    - [2. 中文 commit message 模板](#2-中文-commit-message-模板)
    - [Subject 行规范](#subject-行规范)
    - [Body 编写规范](#body-编写规范)
    - [Breaking Changes 标注](#breaking-changes-标注)
    - [Issue 关联](#issue-关联)
    - [commitlint 中文配置（可选）](#commitlint-中文配置可选)

## 1. 基本规则

| 类型 | 规则 | 示例 |
| --- | --- | --- |
| 分支命名 | 按项目现有规则执行；没有规则时使用简短英文 kebab-case，表达任务范围。 | `feature/project-memory` |
| 提交信息 | 使用中文标题和必要的中文正文，优先描述阶段成果、原因、验证和风险。 | `记忆策略：完善中文提交说明` |
| PR 描述 | 使用中文概括变更、验证结果、风险和未完成事项。 | `本次完善提交策略并补充验证说明。` |

## 2. 提交策略

- 阶段性完成后应整理差异和验证结果；只有用户明确授权提交时才创建本地提交。
- 一个提交应对应一个清晰的阶段成果：功能实现、Bug 修复、测试补充、文档/记忆更新或重构收敛。
- 提交前先查看 `git status` 和 `git diff --stat`，确认只包含本阶段相关文件。
- 提交前尽量运行与本阶段相关的最小验证，并在最终回复或 PR 描述中说明结果。
- 提交信息必须使用中文。标题保持一行且具体，正文承担历史追踪职责，避免关键信息只存在临时对话。
- 提交信息的标题（含 scope）、正文和页脚均不得出现具体工作包编号或其变体。使用能力、模块及行为描述变更；工作包编号仅保留在项目记忆和设计文档中，不作为提交范围名或追踪信息写入 message。
- 非微小改动必须写提交正文；只改错别字、格式或单行配置时可以只写标题。
- `push` 授权必须明确远端和分支，不包含标签或 force-push。合并、rebase、cherry-pick、继续冲突中的 Git 操作和清理分支/worktree 均需单独授权。

## 3. 提交格式

基于 Conventional Commits 1.0.0 规范，针对中文团队的实际使用习惯进行适配。

### 类型（type）定义

| 类型       | 说明                         | 示例场景                   |
| ---------- | ---------------------------- | -------------------------- |
| `feat`     | 新功能                       | 添加用户注册模块           |
| `fix`      | 修复缺陷                     | 修复登录页白屏问题         |
| `docs`     | 文档变更                     | 更新 API 接口文档          |
| `style`    | 代码格式（不影响逻辑）       | 调整缩进、补充分号         |
| `refactor` | 重构（非新功能、非修复）     | 拆分过长的服务类           |
| `perf`     | 性能优化                     | 优化首页列表查询速度       |
| `test`     | 测试相关                     | 补充用户模块单元测试       |
| `chore`    | 构建/工具/依赖变更           | 升级 webpack 到 v5         |
| `ci`       | 持续集成配置                 | 修改 GitHub Actions 流程   |
| `revert`   | 回滚提交                     | 回滚 v2.1.0 的登录重构     |

**原则**

- type 保留英文关键字（工具链兼容性好）
- scope 和 description 使用中文
- body 使用中文完整描述

### 2. 中文 commit message 模板

```
<type>(<scope>): <subject>

<body>

<footer>
```

**完整示例**

```
feat(用户模块): 添加手机号一键登录功能

- 接入运营商一键登录 SDK
- 支持移动、联通、电信三网
- 登录失败自动降级到短信验证码

Closes #128
```

```
fix(订单): 修复并发下单导致库存超卖的问题

在高并发场景下，原有的库存扣减逻辑存在竞态条件。
改用 Redis 分布式锁 + 数据库乐观锁双重保障。

影响范围：订单服务、库存服务
测试确认：已通过 500 并发压测验证

Closes #256
```

### Subject 行规范

**格式**

```
<type>(<scope>): <description>
```

**规则**

- **type**: 必填，从上方类型表中选取
- **scope**: 选填，表示影响范围，使用中文模块名
  - 示例：`用户模块`、`订单`、`支付`、`基础组件`
- **description**: 必填，中文简述，不超过 50 个字符
  - 使用动宾短语：「添加 xxx」「修复 xxx」「优化 xxx」
  - 不加句号结尾
  - 不要写「修改了代码」这种无意义描述

**好的示例**

```
feat(权限): 添加基于 RBAC 的细粒度权限控制
fix(支付): 修复微信支付回调签名验证失败的问题
perf(列表页): 优化大数据量表格的虚拟滚动渲染
refactor(网关): 将单体网关拆分为独立微服务
```

### Body 编写规范

Body 用于详细说明本次变更的动机、方案和影响。

**编写要点**

- 说明**为什么**要做这个改动（背景/原因）
- 说明**怎么做**的（技术方案摘要）
- 说明**影响范围**（哪些模块、接口受影响）
- 每行不超过 72 个字符（中文约 36 个汉字）
- 正文与标题之间空一行

**Body 模板**

```
<改动背景和原因>

技术方案：
- <方案要点 1>
- <方案要点 2>

影响范围：<受影响的模块或服务>
```

### Breaking Changes 标注

当提交包含不兼容变更时，在 footer 中标注，在 type 后加感叹号。

```
feat(接口)!: 重构用户信息返回结构

将用户接口返回的扁平结构改为嵌套结构，前端需同步调整字段取值路径。

BREAKING CHANGE: /api/user/info 返回结构变更
- avatar 字段移入 profile 对象
- 移除已废弃的 nickname 字段，统一使用 displayName
```


**团队约定**

- 涉及数据库表结构变更 -> 必须标注 BREAKING CHANGE
- 涉及公共 API 参数/返回值变更 -> 必须标注
- 涉及配置文件格式变更 -> 必须标注
- 标注时须写明迁移方法或升级步骤

### Issue 关联

**GitHub 格式**

```
Closes #128
Refs #129, #130
```

### commitlint 中文配置（可选）

**安装**

```bash
npm install -D @commitlint/cli @commitlint/config-conventional
```

**commitlint.config.js**

```javascript
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [2, 'always', [
      'feat', 'fix', 'docs', 'style', 'refactor',
      'perf', 'test', 'chore', 'ci', 'revert'
    ]],
    'type-case': [2, 'always', 'lower-case'],
    'type-empty': [2, 'never'],
    'subject-empty': [2, 'never'],
    'subject-max-length': [2, 'always', 100],
    // 允许中文字符，关闭 subject-case 限制
    'subject-case': [0],
    // 关闭 header-max-length 或放宽（中文占宽较大）
    'header-max-length': [2, 'always', 120],
    'body-max-line-length': [1, 'always', 200],
    'footer-max-line-length': [1, 'always', 200]
  },
  prompt: {
    messages: {
      type: '选择提交类型:',
      scope: '输入影响范围（可选）:',
      subject: '填写简短描述:',
      body: '填写详细描述（可选，使用 "|" 换行）:',
      breaking: '列出不兼容变更（可选）:',
      footer: '关联的 Issue（可选，例如 #123）:',
      confirmCommit: '确认提交以上信息？'
    }
  }
}
```
