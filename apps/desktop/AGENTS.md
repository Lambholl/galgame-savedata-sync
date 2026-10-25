# 应用开发规则

适用于 `apps/desktop` 及其所有子目录。

## 目录

- [开发前置条件](#开发前置条件)
- [组件库与平台边界](#组件库与平台边界)
- [验证](#验证)

## 开发前置条件

- 当前 Agent 必须已发现并完整读取 `antd` skill；缺失或无法加载时停止开发。
- 根据当前 Agent 的技能目录定位 `SKILL.md`，不依赖某台机器的绝对路径。
- 编写或修改 Ant Design 组件前，依 skill 检查 CLI 可用性，并查询项目实际依赖版本的 API、示例和需要的设计 token；结构化查询使用 `--format json`。

## 组件库与平台边界

- `desktop/` 使用 Electron、React 与 `antd`；组件查询匹配该工作区实际安装的 `antd` 版本。

## 验证

- 修改桌面 Ant Design 代码后，按 skill 对变更文件运行 `antd lint --format json`。
- 按改动范围执行验证；应用代码完成后运行仓库根目录的 `pnpm check`。
