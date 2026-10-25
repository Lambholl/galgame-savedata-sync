# Windows 目录读取适配

## 目录

- [1. 范围与入口](#1-范围与入口)
- [2. 主进程接口](#2-主进程接口)
- [3. 有限 IPC](#3-有限-ipc)
- [4. 配置与路径边界](#4-配置与路径边界)
- [5. 验证](#5-验证)

## 1. 范围与入口

`src/main/directory-adapter.ts` 提供 Windows 本机的目录登记、恢复、当前层元数据和原生只读文件流。目录通过系统选择器进入主进程，Renderer 不提交绝对路径；界面按钮与浏览布局在后续界面工作包接入。

本包不提供源目录写入、覆盖、删除、暂存发布或 HTTP 服务。真实用户目录仅用于只读检查；自动化测试只修改自己创建的临时夹具。文件夹名称不用于推断游戏运行器或存档格式。

## 2. 主进程接口

| 接口 | 输入/输出 | 生命周期与失败 |
| --- | --- | --- |
| createDirectoryAdapter(configPath) | 主进程控制的绝对配置路径，返回适配器 | 不存在时创建身份；损坏/未知 schema、无效文件或权限失败抛异常，不重置原配置 |
| adapter.deviceId | 返回安装内稳定设备 ID | 与 IP 无关，不从机器 MAC 生成 |
| adapter.registerDirectory(path) | 仅系统选择器/受信任本地调用传入绝对目录；返回 OperationResult&lt;DirectoryReference&gt; | 配置保存后才更新内存；再次明确选择同一路径保留 rootId，重新核实身份并清除该根的旧条目引用 |
| adapter.listRoots() | 返回公开根引用列表 | 重查根身份；失效根标 unavailable，仍保留配置，不冒充空目录 |
| adapter.listDirectory(rootId, parentId=null) | 当前层 DirectoryListing | 根层 parentId=null；子层必须使用已采集目录的 entryId。不会递归读取后代，不汇总目录大小；不支持的链接/类型及读取失败返回错误 |
| adapter.openFile(reference) | 本进程有效的 EntryReference，返回 metadata 和 Node Readable | 文件按只读方式打开，校验引用与句柄身份；调用者必须消费流或 destroy，流自动关闭句柄。读取过程错误需监听/捕获，内容变化由后续传输层校验 |

除初始化工厂外，异步操作失败均返回稳定错误包络；内部 `DirectoryAccessError` 保留 cause，IPC 只输出脱敏后的 code/message/canRetry，不包含主机路径、堆栈或文件内容。

```ts
// 受信任主进程示例；配置必须位于源目录之外。
import { createDirectoryAdapter } from './src/main/directory-adapter.ts'

async function inspectChosenDirectory(configPath: string, chosenPath: string): Promise<void> {
  const adapter = await createDirectoryAdapter(configPath)
  const selected = await adapter.registerDirectory(chosenPath)
  if (selected.status === 'error') throw new Error(selected.error.message)
  const listing = await adapter.listDirectory(selected.value.rootId)
  if (listing.status === 'error') throw new Error(listing.error.message)
  // UI 仅展示本次条目；不得把它保存为下次同步的共同历史基线。
  console.log(listing.value.entries.length)
}
```

## 3. 有限 IPC

preload 通过 `window.desktopDirectories` 暴露冻结的 `DesktopDirectoryApi`：

- `chooseDirectory()`：无参数，主进程打开系统选择器；取消返回 cancelled 并保留既有根。
- `listRoots()`：无参数，只返回公开根描述。
- `listDirectory(rootId, parentId?)`：默认根层；仅接受不透明 ID，不接受名称或路径。

固定通道为 directories:choose、directories:roots、directories:list。主进程检查窗口登记、主 frame 身份及精确 renderer URL；选择器返回后再次核实来源。子 frame、导航后的页面、额外参数、非法 ID 和附加路径字段均被拒绝。preload 另检查输入和响应结构，异常映射为脱敏错误；不会暴露 ipcRenderer、通用 invoke、Node 句柄或文件字节。

应用退出时移除 handler，窗口关闭时删除可信窗口记录；应用采用单实例锁避免通常情况下多个应用实例同时更新同一配置。该包没有事件订阅，网页调用者不持有需要释放的文件句柄。

## 4. 配置与路径边界

应用在 `app.getPath('userData')/directory-config.json` 保存 schemaVersion=1、deviceId 与 roots。内部根记录仅含 rootId、规范路径和 bigint dev/ino 的字符串身份；绝对路径不传到 Renderer，也不写进项目记忆。条目 ID/相对路径映射只在本进程内有效，不保存历史元数据或哈希，重启后重新枚举。

配置写入使用同目录独占临时文件、sync 和 rename；同进程登记串行处理，成功前不更新内存。配置不能位于任何所选根目录内，损坏或未知版本一律停止初始化。配置目录必须由应用控制，本实现不提供跨外部进程的配置事务或锁。

每次读取重新检查根身份；路径逐段 lstat，拒绝 symlink/junction，核对 realpath 与根范围，读取句柄再核对身份。文件/目录替换使旧引用失效，需要刷新或明确重新选择。当前策略拒绝所有遇到的链接，不自动跟随根内链接；不支持的条目导致该层读取失败，不能静默显示为空目录。

Node 的路径检查与文件打开不是同一个原子操作。本实现检查可观察到的替换和越界，不承诺在外部进程恶意并发重排命名空间时提供内核级隔离；不引入目录级原子替换承诺。真正的内容哈希、源变化校验、写入授权和发布竞争由后续传输/写入工作包处理。

Electron 构建显式内联 workspace 共享包，避免 sandbox preload 在运行时 require TypeScript 源码。preload 保留 CJS 输出，contextIsolation/sandbox 开启，Renderer 无 Node 集成。

## 5. 验证

`pnpm test:desktop` 使用 Node 内置测试器执行 16 项临时目录/IPC 检查，并已接入 `pnpm check`。覆盖 Unicode/空文件、配置恢复、当前层枚举、根/条目替换、junction 越界、原生读流释放、跨根引用、取消选择、IPC 参数和主 frame 信任边界。临时夹具先通过异步 realpath 解析系统临时目录，创建与清理使用同一真实根，避免 Windows 8.3 短路径引发路径校验差异；测试不硬编码真实存档位置。

Windows 短路径回归通过 PowerShell 调用 GetShortPathName，生成真实 8.3 别名，并在只影响子进程的 TEMP/TMP 环境中重跑目录与 IPC 用例，要求全部通过。非 Windows 或卷未生成不同短名时明确跳过此项；常规用例仍执行。此修复只调整测试夹具，不放宽业务代码的链接、根范围和身份检查。

额外只读验证通过用户授权的真实 Windows 目录执行：读取前后文件内容哈希、条目和目录修改时间一致，原生读流一致，配置恢复成功；具体路径及文件哈希不进入仓库。该检查不代表 Android、HTTP 传输、原生选择器人工点击或完整界面已验收。

参考：[Node 文件系统](https://nodejs.org/docs/latest-v22.x/api/fs.html)、[Electron IPC 来源校验](https://www.electronjs.org/docs/latest/tutorial/security#17-validate-the-sender-of-all-ipc-messages)、[系统目录选择器](https://www.electronjs.org/docs/latest/api/dialog)。
