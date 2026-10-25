# Agent 开发规则

适用于整个仓库及其所有子目录。

- **开发前必须具备 `antd` skill**：当前 Agent 必须能够发现并完整读取来自 [ant-design/ant-design-cli](https://github.com/ant-design/ant-design-cli/tree/main/skills/antd) 的 `antd` skill，之后才能新增或修改代码、测试及工程配置。仅安装 `@ant-design/cli` 不等于已安装 skill。
- 若 skill 缺失、不可读或当前 Agent 无法加载，停止开发并明确告知缺少 `antd` skill，提供安装方式；只可继续只读调查、解释与文档维护，不得绕过要求直接编码。
- 开始工作先读取 [.project-memory/INDEX.md](.project-memory/INDEX.md)，按任务定位项目规范；不在本文件复制规范正文。
- **仅在用户明确授权提交时才执行 Git commit**。未明确说明时间、次数或其他范围的授权视为当前工作包的一次提交授权，成功提交后即耗尽；后续提交须重新授权。提交前读取[提交规范](.project-memory/standards/commit-style.md)，核对授权范围与有效性，不复用历史授权。
- 修改 `apps/` 下任何文件前，必须读取 [apps/AGENTS.md](apps/AGENTS.md) 及目标目录中更具体的指令。即使工具未自动注入子目录规则，也必须主动读取。
