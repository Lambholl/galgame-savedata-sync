import { contextBridge, ipcRenderer } from 'electron'
import { createDirectoryBridge } from '../directory-bridge.ts'

contextBridge.exposeInMainWorld('desktopRuntime', Object.freeze({ platform: process.platform }))
contextBridge.exposeInMainWorld(
  'desktopDirectories',
  createDirectoryBridge((channel, ...args): Promise<unknown> =>
    ipcRenderer.invoke(channel, ...args),
  ),
)
