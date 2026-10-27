# 双端界面独立与目录迁移实现计划

> 按共享基础、桌面界面、移动界面三个任务分工，集成后做独立审查。用户已授权开始执行；不提交或推送。

**目标：** 源码归入 `apps/mobile`、`apps/desktop`、`apps/shared`，两端独立维护界面和交互。

**架构：** shared 保存纯 TypeScript 数据与规则，各端独立持有页面、状态、样式和平台适配。保留协议、存储格式与原生传输行为。

**技术栈：** React、TypeScript、Electron、Capacitor；桌面 antd，移动优先 antd-mobile，使用桌面组件时也满足触控要求。

**规格：** [目录设计](../specs/2026-10-27-app-directory-design.md)。用户最新要求优先于草案中“移动端移除 antd”的建议。

## 目录

- [全局约束](#全局约束)
- [文件与接口](#文件与接口)
- [任务](#任务)
- [审查重点](#审查重点)
- [进度](#进度)

## 全局约束

- 使用现有工作区的 `codex/separate-platform-ui` 分支，保留用户数据和已有改动。
- shared 包名仍为 `@savedata-sync/shared`；既有公开导出保持可用。
- 各端业务接入独立，源码不相互导入；shared 无 React、DOM、Node 或平台依赖。
- 移动交互至少 48 × 48 CSS px 点击区域；游戏菜单主卡片和双列次级卡片最小高度 64 CSS px。
- 移动优先 antd-mobile；保留 antd 的位置明确设置触控尺寸。
- 保留两端目录并列、分钟级时间、直接显示元数据、暗色纯黑、返回键和后台原生任务恢复。
- 只运行既有相关测试，不新增长期界面测试；不提交、推送或安装到设备。

## 文件与接口

共享基础负责 `apps/shared/**`、根工作区和包配置。移动任务负责 `apps/mobile/**`。桌面任务负责 `apps/desktop/**`。集成任务负责删除旧 UI、文档、记忆、依赖边界检查与构建。

共享新接口：

- `TransferTask`：现有 `UiTask` 的数据字段。
- `TransferRequest`：现有 `UiTransfer` 的数据字段。
- `DirectoryLocation`：现有 `PaneLocation` 的数据字段。
- `unwrap<T>(result: OperationResult<T>): T`，错误时抛出 Error。
- `taskIsActive(task: TransferTask): boolean`，保留现有判断。
- `validateTransferSelection({ isPeerConnected, source, target, names, isReceiveAuthorized }): TransferProblem | null`，返回断连、目录缺失、未选文件、文件名无效、批内重名、目标同名、接收未授权之一，按现有预检顺序判断。
- 游戏关联、解除与导入的纯数据操作由 shared 提供，两端调用；平台持久化、确认和导航归各端。

各端分别定义 `MobileLibraryAdapter` / `DesktopLibraryAdapter` 和本地快照类型；不强求不支持的操作存在。共享 UI 源文件作为迁移材料保留至两端完成。

## 任务

### 1. 共享基础迁移

- [x] 将 shared 搬入 apps，分类 protocol/library/transfer/validation，更新测试直接路径并保留公共导出。
- [x] 提取以上纯数据接口和规则，修改工作区为三个明确目录；过渡期加入旧 UI 包。
- [x] 更新根构建与已有 shared 测试入口，执行 shared 类型检查和既有测试；独立规格与质量审查通过。

### 2. 桌面独立界面

- [x] 将共享页面迁入桌面 app/features/components/styles；移除移动分支和移动组件依赖。
- [x] 桌面桥归 src/bridge，renderer 平台适配归 platform；更新测试和桥引用。
- [x] 游戏和传输规则接入 shared，清理已核实无用途旧组件。
- [x] 查询实际 antd 版本 API，运行 antd lint、桌面类型检查和既有桌面测试。

### 3. 移动独立界面

- [x] 独立 app/features/components/styles/platform，页面与界面状态放回 mobile。
- [x] 用移动组件实现页面和弹层；游戏菜单恢复主操作卡片和双列卡片。
- [x] 双列文件使用可触控列表，保留完整元数据、独立滚动和失效清选择。
- [x] 原生桥和存储搬入 platform，保留返回顺序、后台轮询暂停与任务恢复；更新测试导入。
- [x] 运行移动类型检查、既有移动测试与构建。

### 4. 集成与验收

- [x] 删除旧 packages/ui、根 packages 和依赖引用，重装工作区链接及更新锁文件。
- [x] 配置依赖边界检查，防止共享包引入 UI/平台和两端互引。
- [x] 同步 README、接口说明、项目记忆和设计文档。
- [x] 执行 pnpm check、受影响既有套件、Android 构建、独立代码审查；根据可用环境检查页面显示。

## 审查重点

1. 目录和设备切换后不得沿用旧选择或旧请求结果。
2. 保存失败保留表单草稿，点击确认重复触发不得产生并发操作。
3. 弹层和页面切换不取消原生任务，返回键优先关闭最上层界面。
4. 常规字号、常用手机尺寸和长名称下文件元数据完整，操作区域不被压缩；按用户后续要求不验证极端字体大小。
5. shared 的字段、存储 schema 和协议字节语义保持兼容。

前三项通过代码审查、既有平台测试和可运行页面检查；第四项通过实际渲染检查；第五项通过既有 shared、IPC 与移动桥套件。

## 进度

四项任务已完成。shared、桌面、移动分项审查与最终整体审查通过；移动端切换设备后本机目录未重新回报的问题已修复并定向复审。最终 pnpm check、56 项既有共享/桌面/移动测试、Android 构建通过；常规字号的移动菜单、双列文件和桌面页面已用真实组件渲染检查。原生真机及跨端操作已通过验收。
