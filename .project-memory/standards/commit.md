---
doc_type: standards-commit
status: active
updated: 2026-11-19
tags: [提交规范]
---

# 提交约定

`git-workflow` 技能的项目取值和差异。通用规则见该技能，这里不重复。

## 目录

- [取值](#取值)
- [差异](#差异)

## 取值

| 项目 | 取值 |
| --- | --- |
| 提交信息语言 | 中文；`type` 用英文 |
| scope 列表 | 中文模块名，可以省略，如 `同步`、`设备页`、`备份`、`发布`、`记忆` |
| 分支命名 | 主分支 `master`；其他分支用简短英文 kebab-case，如 `fix/backup-rotation` |
| 发布方式 | 在 master 的提交上打 `vX.Y.Z` tag，推送后由 GitHub Actions 构建并创建草稿 Release，步骤见 `docs/development.md` 的“版本号与发布” |

## 差异

| 规则 | 原因 | 适用范围 |
| --- | --- | --- |
| master 和 tag 一起推送：`git push --atomic origin master vX.Y.Z`。打 tag 和推送 tag 都要维护者同意，同意里写明 tag 名 | 发布工作流要求 tag 指向的提交已在 `origin/master` 上，只推 tag 会在构建前失败 | 发布 |
| 不使用发布分支，补丁版本也在 master 上修复后打 tag | 只有一条发布线 | 发布 |
