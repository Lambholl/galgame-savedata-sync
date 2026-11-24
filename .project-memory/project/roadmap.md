---
doc_type: roadmap
status: active
id_prefix: M
id_high_water: 6
updated: 2026-11-24
tags: [路线图, 里程碑]
---

# 项目路线图

## 目录

- [1. 里程碑](#1-里程碑)
- [2. 当前计划](#2-当前计划)
- [3. 真实存档开放](#3-真实存档开放)

只保留当前和计划中的里程碑；已完成阶段的有效结果吸收到项目目标、架构或决策后删除历史行。

## 1. 里程碑

| 里程碑 | 目标 | 计划时间 | 状态 |
| --- | --- | --- | --- |
| M-006 | 发布 1.0.0：实现 [ADR-0006](../decisions/ADR-0006-stable-release-compatibility.md) 的兼容机制，Android 自动添加 `.nomedia`，精简测试并补兼容回归，发布前在本地验证完打包产物和升级路径 | 待定 | planned |

## 2. 当前计划

M-006 的事项按表中顺序做，每项开始前细化成工作包，真机验证用 `scripts/device/` 的工具。发布前验证要覆盖前面各项的结果，放最后。

| 优先级 | 事项 | 依赖 | 状态 |
| --- | --- | --- | --- |
| P1 | Android debug 包诊断接口：只在 `BuildConfig.DEBUG` 下注册的广播，把本机服务、连接和任务状态输出到 logcat，并提供故障注入开关（存储不足、写入变慢、连接断开等，具体项实现时确定）；release 包不含这段代码 | 无 | planned |
| P1 | 兼容回归：发版时保存该版本写出的落盘文件样本，长期测试核对当前版本能读或迁移全部已发布样本、较新版本的数据不被删除；Java 与 TypeScript 的版本常量对照；电脑端备份与恢复；两个电脑端实例经回环地址完整复制并核对哈希（发版前运行，不进 `pnpm test`） | 无 | planned |
| P1 | 发布文档：`docs/development.md` 的“兼容性与卸载”和“版本号与发布”按 ADR-0006 改写；`architecture/shared-package.md` 第 1 节的测试版表述改为 1.0 规则；发布说明写明 0.x 的数据不迁移 | 无 | planned |
| P1 | 发布前验证：打包产物和 Android 之间的连接与双向传输；pkg 打包后的安装版重测；安装包的模式选择页和 UAC；打包产物上数据读不懂时的启动；两端从 v0.5.0 覆盖安装 1.0 后的重置提示；`pnpm security:check` 重跑并更新[当前回归状态](../testing/regression-notes.md) | 以上各项 | planned |
| P3 | 电脑端支持 Linux：存储目录已按 XDG 规划；推荐地址模块（现用 `route print`、`reg query`）、短路径测试和 `Windows*` 命名要另做 | 无 | planned |

## 3. 真实存档开放

M-002 已收口，真实存档覆盖按[验收标准](../testing/acceptance.md)第 1 节的范围开放。
