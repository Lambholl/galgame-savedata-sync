---
doc_type: test-cases
status: active
priority: medium
owner: testing
id_prefix: TC
id_high_water: 35
updated: 2026-10-27
tags: [测试用例]
related_files: []
---

# 测试用例

这里保留当前需要长期复验的功能场景。已经完成且没有后续风险的历史用例、界面细节和一次性实验由 Git 保存。编号不复用。

| ID | 场景 | 验证方式 | 预期结果 | 状态 |
| --- | --- | --- | --- | --- |
| TC-002 | 共享设备、目录和批量数据结构 | 相关既有测试与 `pnpm typecheck` | 合法数据通过；缺项、错误角色、错位目标和超限值被拒绝 | passed |
| TC-003 | Windows 目录读取与有限 IPC | `pnpm test:desktop` | 只读当前层；空目录、失效授权和非法引用可区分；不暴露路径、内容或写入接口 | passed |
| TC-004 | Android SAF 授权、取消与重启 | 真机系统选择器；必要时运行既有设备测试 | 选择、取消和重启恢复可用；真实源保持只读 | passed |
| TC-006 | Windows HTTP 发送端 | `pnpm test:desktop` 的 HTTP 组 | 设备、目录、清单和内容可读取；任务只领取一次；sender sent 与 receiver succeeded 分开 | passed |
| TC-007 | 双端批量文件往返 | 双端构建加实际局域网传输 | 空文件、Unicode 名称和超过缓冲区的文件逐字节一致 | passed |
| TC-008 | 目标名称冲突与非覆盖发布 | 独立合成目标；相关既有测试或手工操作 | 既有文件保持不变；冲突明确失败；无法确认时报告待确认 | passed |
| TC-009 | 非法归档与传输中断 | 相关既有测试；必要时使用独立合成夹具 | 校验完成前不发布；截断、损坏、超限和源变化不会报告成功 | passed |
| TC-011 | Android 后台传输与显式取消 | 真机、通知和实际局域网 | 切后台或 Activity 重建不取消已有任务；完成或显式取消后释放通知和服务 | passed |
| TC-012 | 结果未知与会话重启 | 相关既有测试加手工核实 | 响应丢失只查询，写入不重放；未知结果要重读目标确认 | partial |
| TC-014 | Android 平台组合 | Android 10 与较新系统的真机 | 目录、归档、发布和 HTTP 行为在各目标系统上单独记录 | passed |
| TC-015 | 最小界面与当前状态边界 | Windows 实际窗口/选择器、API 33 界面及 LAN 操作/截图，外部 SHA-256 核对 | 双向空文件/中文名、子目录刷新后传输、同名冲突、准备前取消/清理重试、页面重载恢复及 64 MiB 后台上传通过；目录不汇总大小；完整平台组合见 TC-014 | passed |

`partial` 表示已有证据但仍有场景未覆盖。`pnpm check` 不运行这些自动化测试；完整回归使用 `pnpm test:all`。
