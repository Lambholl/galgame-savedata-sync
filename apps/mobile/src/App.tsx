import { LibraryApp } from '@savedata-sync/ui'
import { createMobileLibraryAdapter } from './library-adapter'

const ADAPTER = createMobileLibraryAdapter()

/** 正式 Android 应用入口；原生连接与任务独立于页面生命周期。 */
export function App(): React.JSX.Element {
  return <LibraryApp adapter={ADAPTER} />
}
