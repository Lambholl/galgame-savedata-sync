import { APP_NAME } from '@savedata-sync/shared'
import { ConfigProvider, Empty, Layout, Typography } from 'antd'
import zhCN from 'antd/locale/zh_CN'

/** 桌面应用空壳，后续接入项目管理和平台接口。 */
export function App(): React.JSX.Element {
  return (
    <ConfigProvider locale={zhCN}>
      <Layout className="app-shell">
        <Layout.Content className="app-content">
          <Typography.Title>{APP_NAME}</Typography.Title>
          <Empty description="尚未添加同步项目" />
        </Layout.Content>
      </Layout>
    </ConfigProvider>
  )
}
