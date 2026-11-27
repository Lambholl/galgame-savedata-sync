---
doc_type: standards-writing
status: active
updated: 2026-11-27
tags: [写作规范]
---

# 写作约定

`dev-writing` 技能的项目取值和差异。通用规则见该技能，这里不重复。

## 目录

- [取值](#取值)
- [差异](#差异)

## 取值

| 项目 | 取值 |
| --- | --- |
| 文档语言 | 中文（用户说明另提供英文版 `README.en.md`） |
| 中英文之间加不加空格 | 加；中文用全角标点，代码、命令、路径放在反引号里 |
| 面向用户的文档 | 根目录 `README.md`、`README.en.md`：功能、下载、使用和常见问题 |
| 面向开发者的文档 | `docs/development.md`：环境、命令、签名和发布 |
| 面向维护者的文档放在哪 | `.project-memory/`：需求、架构、接口、决定、计划、验收和测试状态 |
| 术语 | [项目术语表](../project/glossary.md) |

## 差异

| 规则 | 原因 | 适用范围 |
| --- | --- | --- |
| `docs/` 只放开发指南。设计、计划、工作包、验收记录和协议细节写进项目记忆对应目录；工具或技能生成的设计稿和计划不放 `docs/`，有用的结论并入记忆后删除 | `docs/` 里的内部文档不受记忆维护规则约束，完成后没人收口，容易和实现对不上 | `docs/` |
| 各应用目录不写 README；平台层的接口、生命周期和资源责任写在 `architecture/desktop.md`、`android.md`、`shared-package.md` | 应用 README 和记忆重复，曾经和实现脱节 | `apps/` |
| 根 README 只写用户看得到的效果，开发内容只放一行链接到 `docs/development.md` | 读者是应用的使用者 | `README.md`、`README.en.md` |
