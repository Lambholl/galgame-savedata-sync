import { LibraryApp } from '@savedata-sync/ui'
import { androidBackButton } from './back-button'
import { createMobileLibraryAdapter } from './library-adapter'

const ADAPTER = createMobileLibraryAdapter()

/** 正式 Android 应用入口；原生连接、任务和系统返回独立于页面组件。 */
export function App(): React.JSX.Element {
  return <LibraryApp adapter={ADAPTER} backButton={androidBackButton} />
}
