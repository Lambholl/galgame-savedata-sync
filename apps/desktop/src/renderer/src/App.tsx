import { APP_NAME } from '@savedata-sync/shared'
import { ConfigProvider, Empty, Layout, Typography, theme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { useSystemDarkMode } from './use-system-dark-mode'

/** 桌面应用空壳，后续接入项目管理和平台接口。 */
export function App(): React.JSX.Element {
  const isDarkMode = useSystemDarkMode()
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{ algorithm: isDarkMode ? theme.darkAlgorithm : theme.defaultAlgorithm }}
    >
      <Layout className="app-shell">
        <Layout.Content className="app-content">
          <Typography.Title>{APP_NAME}</Typography.Title>
          <Empty
            description={<Typography.Text type="secondary">尚未添加同步项目</Typography.Text>}
          />
        </Layout.Content>
      </Layout>
    </ConfigProvider>
  )
}
