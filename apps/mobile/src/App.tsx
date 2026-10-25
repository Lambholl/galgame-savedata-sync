import { APP_NAME } from '@savedata-sync/shared'
import { ConfigProvider, Empty, NavBar } from 'antd-mobile'
import zhCN from 'antd-mobile/es/locales/zh-CN'

/** 移动应用空壳，后续通过原生插件接入目录访问。 */
export function App(): React.JSX.Element {
  return (
    <ConfigProvider locale={zhCN}>
      <NavBar backIcon={false}>{APP_NAME}</NavBar>
      <main className="app-content">
        <Empty description="尚未添加同步项目" />
      </main>
    </ConfigProvider>
  )
}
