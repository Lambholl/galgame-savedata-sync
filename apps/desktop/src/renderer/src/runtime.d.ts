import type { DesktopDirectoryApi } from '../../directory-bridge'
import type { DesktopServiceApi } from '../../service-bridge'
import type { DesktopLibraryApi } from '../../library-bridge'

declare global {
  interface Window {
    readonly desktopDirectories?: DesktopDirectoryApi
    readonly desktopService?: DesktopServiceApi
    readonly desktopLibrary?: DesktopLibraryApi
  }
}
