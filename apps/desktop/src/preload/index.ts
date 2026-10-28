import { contextBridge, ipcRenderer } from 'electron'
import { createDirectoryBridge } from '../bridge/directory-bridge.ts'
import { createServiceBridge } from '../bridge/service-bridge.ts'
import { createLibraryBridge } from '../bridge/library-bridge.ts'
import { createBackupBridge } from '../bridge/backup-bridge.ts'

contextBridge.exposeInMainWorld(
  'desktopBackups',
  createBackupBridge((channel, ...args): Promise<unknown> => ipcRenderer.invoke(channel, ...args)),
)

contextBridge.exposeInMainWorld(
  'desktopLibrary',
  createLibraryBridge((channel, ...args): Promise<unknown> => ipcRenderer.invoke(channel, ...args)),
)

contextBridge.exposeInMainWorld(
  'desktopService',
  createServiceBridge((channel, ...args): Promise<unknown> => ipcRenderer.invoke(channel, ...args)),
)

contextBridge.exposeInMainWorld('desktopRuntime', Object.freeze({ platform: process.platform }))
contextBridge.exposeInMainWorld(
  'desktopDirectories',
  createDirectoryBridge((channel, ...args): Promise<unknown> =>
    ipcRenderer.invoke(channel, ...args),
  ),
)
