---
doc_type: standards-testing
status: active
updated: 2026-11-25
tags: [测试规范]
---

# 测试约定

`coding-standards` 技能 `references/testing.md` 的项目取值和差异。通用规则见该技能，这里不重复。

## 目录

- [取值](#取值)
- [长期测试的取舍](#长期测试的取舍)
- [差异](#差异)

## 取值

| 项目 | 取值 |
| --- | --- |
| 验证要回答的问题 | 功能是否按当前需求工作；存档数据会不会丢失或写错 |
| 相关测试入口 | `pnpm test`：共享包和电脑端 sidecar，不需要 Android 工具。改了 Android 原生代码时另跑 `pnpm android:unit`：Java 单元测试和归档互通核对，复用 Gradle 后台进程 |
| 全量测试入口 | `pnpm test:all`（`pnpm test` 加 `pnpm android:test`，后者在 `android:unit` 之外另跑 Android lint 和两个调试 APK 的构建）；`pnpm check` 和普通 CI 不跑测试 |
| 测试运行器 | Node 内置测试器加类型擦除；Java 单元测试用 JUnit，仪器测试用 AndroidJUnitRunner |
| 测试文件命名 | Node 测试是各包 `test/` 下的 `*.test.mjs`；Java 测试是 `*Test.java` |

## 长期测试的取舍

按 `coding-standards` 技能 `references/testing.md` 的“留还是删”判断，本项目的取值：

| 项目 | 取值 |
| --- | --- |
| 数据 | 存档、游戏配置、目录登记、设备 ID 和备份 |
| 各自升级的两端 | 电脑端和 Android；协议和能力版本必须相同，见 [ADR-0006](../decisions/ADR-0006-stable-release-compatibility.md) |
| 来自外部标准的预期值 | DNS-SD 实例名最多 63 字节、TXT 键名不分大小写、Windows 保留文件名、tar 和 gzip 格式、WebSocket 关闭码、HTTP/1.1 报文格式 |
| 有风险的上限 | 归档的单文件、总量和缓存上限（`BATCH_LIMITS`），超出会撑满缓存；HTTP 请求头的数量和大小上限 |
| 同一构建内的薄桥 | 移动端网页层的 `*-bridge.ts`、电脑端渲染层的目录桥、Tauri 宿主和 sidecar 之间的消息。路径和 URI 不跨桥的检查由执行检查的一侧测：电脑端是 sidecar 的目录通道，Android 是 `DocumentValues` |

## 差异

| 规则 | 原因 | 适用范围 |
| --- | --- | --- |
| 改落盘格式、协议或能力版本时，同时写迁移和对应的长期测试，不另等维护者要求；修复落在数据、协议或文件读写上的缺陷时附一条回归测试，测试名写缺陷的现象；界面缺陷不加测试 | 1.0 起这些是兼容面，回归会丢用户数据或让两端连不上 | 1.0 起的全部代码 |
| 带 `schemaVersion` 的落盘格式和备份清单，每个格式版本在 `apps/desktop/test/fixtures/compat/` 保存一份样本（电脑端和 Android 测试共用），在该版本引入时由真实写入代码生成，路径和文件名只用 ASCII；样本提交后冻结，测试失败时改代码或迁移，不改样本。长期测试核对当前版本能读或迁移全部样本，当前版本的样本读出再写回后内容不变；当前版本没有样本时测试失败。同一主版本内的样本全部保留，升主版本时才删。没有版本的简单设置（端口、界面偏好）不存样本 | 迁移只有拿旧版本的真实输出才能验证；按格式版本存样本，样本数随格式变化增长，不随发版增长；1.x 承诺读取整个主版本内的数据和备份，见 ADR-0006 | 1.0 起的落盘格式和备份 |
| 发版前运行 `pnpm release:loopback`：两个电脑端后端经 127.0.0.1 双向复制合成存档（开备份、删除多余），核对两边文件一致，再各自恢复复制前的备份并核对；不进 `pnpm test` | 要两个后端进程和真实网络连接；监听服务会绑定所有网卡并在局域网广播 | 发版 |
| 打包产物只验证和开发版行为不同的部分，其余功能在开发版上验证的结论直接适用，不单独列为打包产物的未测项。目前的差别和覆盖方式：sidecar 内嵌 Node 22，发布工作流在 Node 22 上跑 `pnpm test:all`；内嵌 Node 只带英文区域数据，编码约定禁止后端用依赖区域数据的接口；pkg 打包、宿主定位并启动 sidecar 可执行文件、便携模式的数据位置，已在 `PATH` 里没有 `node` 的环境验证过（见 [Windows 平台层](../architecture/windows.md)第 15 节）。新增打包或安装步骤，或者能指出某项功能在打包产物上会走不同代码或运行环境时，才把它列为打包产物的验证项 | 打包产物和开发版运行同一份前端和 sidecar 代码，重复验证同样的代码不会发现新问题 | 电脑端发布 |
| 界面按常规字号和常用移动设备尺寸实际运行、截图验收，不验证极端字体大小 | 界面不进长期测试，验收范围要有边界 | 两端界面 |
| `pnpm android:unit` 只在改了 Android 原生代码时跑；`pnpm android:test` 只在准备发布或维护者要求时跑 | 两者都需要 JDK 和 Android SDK。`android:unit` 在后台进程已启动、Java 有改动时约 20 秒；`android:test` 每次启动新的 Gradle 进程并附带 Android lint 和打包，约一分半 | Android 原生 |
| 测试只用合成数据和系统临时目录，不读写真实存档 | 测试失败不能损坏存档 | 全部自动化测试 |
| 归档格式的跨语言夹具 `apps/desktop/test/fixtures/archive-v1.json` 由 Python 标准库独立生成，Node 和 Java 测试共用；`scripts/verify-archive-interop.mjs` 在 `pnpm android:unit` 和 `pnpm android:test` 里核对两端互通 | 两端编解码器各自实现，要有和实现无关的预期 | 归档 |
| 需要真机的测试有 4 项（SAF 选择与读取、归档夹具互通、实际 SAF 两轮快照、依赖 Android 框架的兼容样本核对），运行方法见 [Android 平台层](../architecture/android.md#15-测试范围) | 授权和提供者行为只能在设备上验证 | Android 设备 |
| 同步功能的真机验收按[验收标准](../testing/acceptance.md)在两台设备上做，换设备时重新选择目录，不沿用另一台设备的结论 | 提供者、系统版本和目录授权因设备而异 | 跨端验收 |
