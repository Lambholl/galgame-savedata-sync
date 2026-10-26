import { LibraryApp } from '@savedata-sync/ui'
import { createDesktopLibraryAdapter } from './library-adapter'

const ADAPTER = createDesktopLibraryAdapter()

/** 正式桌面应用入口；原生服务、目录与配置通过有限 IPC 接入。 */
export function App(): React.JSX.Element {
  return <LibraryApp adapter={ADAPTER} />
}
