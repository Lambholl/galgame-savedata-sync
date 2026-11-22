import { invoke, isTauri } from '@tauri-apps/api/core'
import { createBackupBridge } from '../../../bridge/backup-bridge.ts'
import { createDialerBridge } from '../../../bridge/dialer-bridge.ts'
import { createDirectoryBridge } from '../../../bridge/directory-bridge.ts'
import { createLibraryBridge } from '../../../bridge/library-bridge.ts'
import { createPreferencesBridge } from '../../../bridge/preferences-bridge.ts'
import { createServiceBridge } from '../../../bridge/service-bridge.ts'
import { createSyncBridge } from '../../../bridge/sync-bridge.ts'

function callBackend(channel: string, ...args: unknown[]): Promise<unknown> {
  return invoke('backend_invoke', { channel, args })
}

/** 在 Tauri 窗口里把各桌面接口装到 window 上，装上后不能改写；不在 Tauri 里运行时什么都不装。 */
export function installDesktopBridges(): void {
  if (!isTauri()) {
    return
  }
  Object.defineProperties(window, {
    desktopSync: { value: createSyncBridge(callBackend) },
    desktopBackups: { value: createBackupBridge(callBackend) },
    desktopLibrary: { value: createLibraryBridge(callBackend) },
    desktopDialer: { value: createDialerBridge(callBackend) },
    desktopService: { value: createServiceBridge(callBackend) },
    desktopDirectories: { value: createDirectoryBridge(callBackend) },
    desktopPreferences: { value: createPreferencesBridge(callBackend) },
  })
}
