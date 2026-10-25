# Agent 开发规则

适用于整个仓库及其所有子目录。

- **开发前必须具备 `antd` skill**：当前 Agent 必须能够发现并完整读取来自 [ant-design/ant-design-cli](https://github.com/ant-design/ant-design-cli/tree/main/skills/antd) 的 `antd` skill，之后才能新增或修改代码、测试及工程配置。
- 若 skill 缺失、不可读或当前 Agent 无法加载，停止开发并明确告知缺少 `antd` skill，提供安装方式；只可继续只读调查、解释与文档维护，不得绕过要求直接编码。
- 开始工作先读取 [.project-memory/INDEX.md](.project-memory/INDEX.md)，按任务定位项目规范。
