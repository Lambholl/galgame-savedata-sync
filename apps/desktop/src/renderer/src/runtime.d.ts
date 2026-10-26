import type { DesktopDirectoryApi } from '../../directory-bridge'
import type { DesktopServiceApi } from '../../service-bridge'

declare global {
  interface Window {
    readonly desktopDirectories?: DesktopDirectoryApi
    readonly desktopService?: DesktopServiceApi
  }
}
