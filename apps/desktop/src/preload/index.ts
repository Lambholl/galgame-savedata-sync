import { contextBridge } from 'electron'

// 仅提供只读运行环境信息；后续平台接口通过明确的 IPC 契约加入。
contextBridge.exposeInMainWorld('desktopRuntime', Object.freeze({ platform: process.platform }))
