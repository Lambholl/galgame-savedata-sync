import { MobileApp } from './app/MobileApp'
import { androidBackButton } from './app/back-button'
import { createMobileLibraryAdapter } from './platform/library-adapter'

const ADAPTER = createMobileLibraryAdapter()

/** Android 入口，保留同一个连接与原生任务适配器。 */
export function App(): React.JSX.Element {
  return <MobileApp adapter={ADAPTER} backButton={androidBackButton} />
}
