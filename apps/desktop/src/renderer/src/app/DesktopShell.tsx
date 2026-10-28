import type { ReactNode } from 'react'
import { Alert, Button, ConfigProvider, Menu, theme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import {
  AppstoreOutlined,
  ArrowLeftOutlined,
  DesktopOutlined,
  SettingOutlined,
} from '@ant-design/icons'
import appLogo from '../../../../../../assets/app-logo.png'
import { isRootPage } from './navigation.ts'
import type { Page } from './navigation.ts'

const NAV = [
  { key: 'devices', label: '设备', icon: <DesktopOutlined /> },
  { key: 'games', label: '游戏', icon: <AppstoreOutlined /> },
  { key: 'settings', label: '设置', icon: <SettingOutlined /> },
] as const

export function DesktopShell({
  isDark,
  page,
  title,
  gameName,
  error,
  isBusy,
  dialogs,
  onBack,
  onNavigate,
  onCloseError,
  onRetry,
  children,
}: {
  readonly isDark: boolean
  readonly page: Page
  readonly title: string
  readonly gameName: string | null
  readonly error: string
  readonly isBusy: boolean
  readonly dialogs: ReactNode
  readonly onBack: () => void
  readonly onNavigate: (page: Page) => void
  readonly onCloseError: () => void
  readonly onRetry: () => void
  readonly children: ReactNode
}): React.JSX.Element {
  const activeNav = page === 'devices' || page === 'settings' ? page : 'games'
  const isNestedPage = !isRootPage(page)
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: {
          colorPrimary: '#286add',
          borderRadius: 12,
          colorBgLayout: isDark ? '#000000' : '#f0f5fc',
        },
        components: { Card: { bodyPadding: 20 } },
      }}
    >
      <div className={`library-app library-desktop ${isDark ? 'library-dark' : ''}`}>
        <aside className="library-sidebar">
          <div className="library-brand">
            <img src={appLogo} alt="" width={64} height={64} />
            <span>存档同步</span>
          </div>
          <Menu
            mode="inline"
            selectedKeys={[activeNav]}
            items={[...NAV]}
            onClick={({ key }) => onNavigate(key as Page)}
          />
          <small>版本 0.1.0</small>
        </aside>
        <div className="library-surface">
          <header className="library-header">
            <div>
              {isNestedPage && (
                <Button icon={<ArrowLeftOutlined />} onClick={onBack}>
                  游戏
                </Button>
              )}
              <h1>{title}</h1>
              {gameName && isNestedPage && page !== 'task' && <p>{gameName}</p>}
            </div>
          </header>
          <main className="library-main">
            {error && (
              <Alert
                type="error"
                title={error}
                showIcon
                closable={{ onClose: onCloseError }}
                action={
                  <Button size="small" disabled={isBusy} onClick={onRetry}>
                    重试
                  </Button>
                }
              />
            )}
            <div className="library-stack">{children}</div>
          </main>
        </div>
      </div>
      {dialogs}
    </ConfigProvider>
  )
}
