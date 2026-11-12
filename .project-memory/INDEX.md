---
doc_type: index
status: active
updated: 2026-11-13
tags: [Agent导航, 项目记忆]
related_files: []
---

# 项目记忆索引

## 目录

- [1. 读取协议](#1-读取协议)
- [2. 当前工作](#2-当前工作)
- [3. 按需路由](#3-按需路由)
- [文档目录](#文档目录)

## 1. 读取协议

1. 先读本 INDEX，再根据任务和文档 `## 目录` 选择需要的原文章节。
2. 可直接使用 `rg`、`sed`、`head` 或 `cat`；需要章节切片时使用 `read --file <path> --toc|--section <标题>|--full`。
3. 任务范围变化时重新查看导航；规范或路径不明确时先调查再写入。

## 2. 当前工作

| 工作 | 状态 | 相关记忆文档 | 相关代码或配置 | 已完成 | 下一步 |
| --- | --- | --- | --- | --- | --- |
| WP-043 完整首版回归，M-004 收尾 | active | `development/work-packages.md`、`testing/regression-notes.md`、`testing/acceptance.md`、`testing/test-cases.md`、`project/roadmap.md` | 开发版 Electron、Android 13 真机上的当前 debug APK | 当前提交的 APK 已装到 Android 13 真机，开发版 Electron 已启动。用 e2e-gss 游戏（手机 `Download/GSS-E2E-20261102` ↔ 电脑 `.reports/wp029-pc-a`）和真实存档大目录（电脑 save_cn，503 个文件、97 MiB ↔ 手机 `Download/gss-sync-test/big-save`）。大目录小改动两个方向都已通过，两端各发起一次：备份阶段两端界面百分比递增，Android 通知是确定进度条并递增；真实存档原有 502 个文件哈希不变。回归中发现的备份慢已修复：大目录小改动的传输，手机备份约 4～6 秒、电脑备份约 1 秒，比较约 7～8 秒；电脑恢复约 4.5 秒，手机恢复准备约 5～6 秒、确认后约 10 秒；备份百分比仍递增，各份新备份、手机目录和真实存档哈希不变。未查：电脑到手机传输里“正在打包”一个 18 B 的改动约 8 秒。已通过：删除目标多出的条目两个方向各一次（含嵌套文件夹），两端完成说明分开写文件、文件夹和删除数；两端预览的文件夹大小都显示“—”；两端备份删除确认按钮都写“删除”；写入途中结束进程两端各一次——手机被结束后留下一个最终名称的 0 字节文件，重启提示一次“上次写入被中断”，再比较列为覆盖并写好，电脑被结束后留下一个 `.savedata-copy-*.tmp`，重启同样提示，再比较不列入计划，下一次写入删掉，400 个文件哈希两端一致；BUG-010、BUG-012、BUG-014 不再出现。BUG-011 复现时发现电脑目录改回原名后两端仍报授权失效，要断开重连才好，已修复（见接口约定第 7 节），复测改名再改回后两端刷新都能比较。WP-041 文案：取消后的部分完成两端各看一次（被取消的文件和没开始的都算未执行，电脑没有残留候选文件）；打包阶段出错（打包途中把手机目录改名）两端都注明是手机一端，改名触发的是读写失败，授权失效的错误码没有在真机上触发；“等待对方设备开始”和“正在收尾”持续不到一次刷新，没看到；失败又清理失败没有触发。手机作为来源时打包原来约 3 MiB/s，已改为同时读 8 个文件、缓存文件不单独 fsync：700 个文件、175 MiB 打包约 15 秒（原来按每个文件约 77 ms 算约 54 秒），两端 700 个文件哈希一致，电脑到手机方向也照常。未查：这次传输里电脑校验约 8 秒、写入 700 个文件约 21 秒；电脑到手机新建 278 个文件、约 70 MiB 共约 66 秒；电脑发起电脑到手机时，“正在打包 0%”有时持续 2～30 秒 | 需要维护者操作的：中途断网、BUG-013（移除游戏后要在两端重新选目录关联）、BUG-015 旋转或深色模式、BUG-016 重新选择手机目录；之后更新验收、TC-050/TC-051 和回归状态 |

开始产品、代码或文档工作前登记范围、入口和下一步；检查点和阻塞时更新。做完并验证后先更新长期事实，再把状态改为 `in-review`；有新修改时改回 `active`，维护者验收后才删除该行。

## 3. 按需路由

| 任务信号 | 首选目录 | 说明 |
| --- | --- | --- |
| 目标、术语、路线图 | `project/` | 读取命中的当前章节 |
| 需求、范围、约束 | `requirements/` | 以当前表述和开放问题为准 |
| 当前架构、接口、数据流、决策 | `architecture/`、`decisions/` | 先看事实，再按需看决策理由 |
| 实现、模块、代码地图、已知问题、风险 | `development/` | 关注当前状态、入口和工作包；问题和风险只保留仍开放的项 |
| 代码实现或代码测试 | 项目规范、通用编码规则和匹配语言规则 | 只读取与目标文件匹配的规范 |
| 测试规则、用例、验收 | `testing/`、`standards/testing-style.md` | 按当前验证范围选择章节 |
| Git 提交 | `standards/commit-style.md` | 需要提交时读取 |

## 文档目录

| 文档 | 标题 | 状态 | 标签 |
| --- | --- | --- | --- |
| `architecture/api-contracts.md` | 接口约定 | active | API, 接口约定 |
| `architecture/dependencies.md` | 架构依赖 | draft | 依赖 |
| `architecture/overview.md` | 架构总览 | active | 架构总览 |
| `decisions/ADR-0002-ui-library-and-shared-rendering.md` | ADR-0002 维持 antd 系列，抽取双端共用渲染 | accepted | 决策, 界面, 组件库, 共用组件 |
| `development/code-map.md` | 代码地图 | active | 代码地图 |
| `development/implementation-notes.md` | 实现细节 | active | 实现细节 |
| `development/known-issues.md` | 已知问题 | active | 已知问题 |
| `development/module-status.md` | 模块状态 | active | 模块状态, 开发进度 |
| `development/risks.md` | 风险登记表 | active | 风险 |
| `development/work-packages.md` | 工作包登记 | active | 工作包, M-002, M-003, M-004, 验收 |
| `project/charter.md` | 项目章程 | active | 项目目标, 成功标准 |
| `project/glossary.md` | 项目术语表 | draft | 术语 |
| `project/roadmap.md` | 项目路线图 | active | 路线图, 里程碑 |
| `requirements/change-requests.md` | 变更请求 | active | 变更请求 |
| `requirements/constraints.md` | 项目约束 | active | 约束 |
| `requirements/open-questions.md` | 开放问题 | active | 开放问题 |
| `requirements/product.md` | 产品需求 | active | 产品需求 |
| `requirements/scope.md` | 项目范围 | active | 范围 |
| `standards/coding-style.md` | 项目级编码规范 | active | 编码规范 |
| `standards/commit-style.md` | 提交规范 | active | 提交规范 |
| `standards/testing-style.md` | 测试规范 | active | 测试规范 |
| `testing/acceptance.md` | 验收标准 | active | 验收标准 |
| `testing/coverage-gaps.md` | 测试覆盖缺口 | active | 测试缺口 |
| `testing/regression-notes.md` | 当前回归状态 | active | 回归测试, 当前状态 |
| `testing/test-cases.md` | 测试用例 | active | 测试用例 |
