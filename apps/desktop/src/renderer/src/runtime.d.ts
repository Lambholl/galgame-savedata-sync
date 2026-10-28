import type { DesktopDirectoryApi } from '../../bridge/directory-bridge'
import type { DesktopServiceApi } from '../../bridge/service-bridge'
import type { DesktopLibraryApi } from '../../bridge/library-bridge'
import type { DesktopBackupApi } from '../../bridge/backup-bridge'

declare global {
  interface Window {
    readonly desktopDirectories?: DesktopDirectoryApi
    readonly desktopService?: DesktopServiceApi
    readonly desktopLibrary?: DesktopLibraryApi
    readonly desktopBackups?: DesktopBackupApi
  }
}
