import type { DesktopDirectoryApi } from '../../bridge/directory-bridge'
import type { DesktopServiceApi } from '../../bridge/service-bridge'
import type { DesktopLibraryApi } from '../../bridge/library-bridge'
import type { DesktopBackupApi } from '../../bridge/backup-bridge'
import type { DesktopSyncApi } from '../../bridge/sync-bridge'
import type { DesktopPreferencesApi } from '../../bridge/preferences-bridge'

declare global {
  interface Window {
    readonly desktopDirectories?: DesktopDirectoryApi
    readonly desktopService?: DesktopServiceApi
    readonly desktopLibrary?: DesktopLibraryApi
    readonly desktopBackups?: DesktopBackupApi
    readonly desktopSync?: DesktopSyncApi
    readonly desktopPreferences?: DesktopPreferencesApi
  }
}
