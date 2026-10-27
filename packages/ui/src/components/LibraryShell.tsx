import type { ReactNode } from 'react'
import { Alert, Button, ConfigProvider, Menu, theme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { ConfigProvider as MobileConfigProvider, NavBar, TabBar } from 'antd-mobile'
import mobileZhCN from 'antd-mobile/es/locales/zh-CN'
import {
  AppstoreOutlined,
  ArrowLeftOutlined,
  DesktopOutlined,
  SettingOutlined,
  SwapOutlined,
} from '@ant-design/icons'
import { isRootPage } from '../library-types.ts'
import type { Page } from '../library-types.ts'

const NAV = [
  { key: 'devices', label: '设备', icon: <DesktopOutlined /> },
  { key: 'games', label: '游戏', icon: <AppstoreOutlined /> },
  { key: 'settings', label: '设置', icon: <SettingOutlined /> },
] as const

export function LibraryShell({
  isMobile,
  isDark,
  page,
  title,
  gameName,
  error,
  isBusy,
  footer,
  dialogs,
  onBack,
  onNavigate,
  onCloseError,
  onRetry,
  children,
}: {
  readonly isMobile: boolean
  readonly isDark: boolean
  readonly page: Page
  readonly title: string
  readonly gameName: string | null
  readonly error: string
  readonly isBusy: boolean
  readonly footer: ReactNode
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
      <MobileConfigProvider locale={mobileZhCN}>
        <div
          className={`library-app ${isMobile ? 'library-mobile' : 'library-desktop'} ${isDark ? 'library-dark' : ''}`}
        >
          {!isMobile && (
            <aside className="library-sidebar">
              <div className="library-brand">
                <SwapOutlined /> 存档同步
              </div>
              <Menu
                mode="inline"
                selectedKeys={[activeNav]}
                items={[...NAV]}
                onClick={({ key }) => onNavigate(key as Page)}
              />
              <small>版本 0.1.0</small>
            </aside>
          )}
          <div className="library-surface">
            <header className="library-header">
              {isMobile ? (
                <NavBar back={isNestedPage ? '游戏' : null} onBack={onBack}>
                  {title}
                </NavBar>
              ) : (
                <div>
                  {isNestedPage && (
                    <Button icon={<ArrowLeftOutlined />} onClick={onBack}>
                      游戏
                    </Button>
                  )}
                  <h1>{title}</h1>
                  {gameName && isNestedPage && page !== 'task' && <p>{gameName}</p>}
                </div>
              )}
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
            {footer}
          </div>
          {isMobile && (
            <div className="library-bottom">
              <TabBar activeKey={activeNav} onChange={(value) => onNavigate(value as Page)}>
                {NAV.map((item) => (
                  <TabBar.Item key={item.key} icon={item.icon} title={item.label} />
                ))}
              </TabBar>
            </div>
          )}
        </div>
        {dialogs}
      </MobileConfigProvider>
    </ConfigProvider>
  )
}
