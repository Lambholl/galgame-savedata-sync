import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { Button, ConfigProvider } from 'antd-mobile'
import zhCN from 'antd-mobile/es/locales/zh-CN'
import {
  AppstoreOutlined,
  ArrowLeftOutlined,
  DesktopOutlined,
  SettingOutlined,
  CloseOutlined,
} from '@ant-design/icons'
import { isRootPage } from '../app/navigation-types'
import type { Page } from '../app/navigation-types'

const NAV = [
  { key: 'devices', label: '设备', icon: <DesktopOutlined /> },
  { key: 'games', label: '游戏', icon: <AppstoreOutlined /> },
  { key: 'settings', label: '设置', icon: <SettingOutlined /> },
] as const

export function LibraryShell({
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
  const active = page === 'devices' || page === 'settings' ? page : 'games'
  const main = useRef<HTMLElement>(null)
  useEffect(() => {
    main.current?.scrollTo({ top: 0 })
  }, [page])
  return (
    <ConfigProvider locale={zhCN}>
      <div className="mobile-app">
        <header className="app-heading">
          {!isRootPage(page) && (
            <Button
              fill="none"
              aria-label={page === 'preview' ? '返回传输存档' : '返回游戏'}
              onClick={onBack}
            >
              <ArrowLeftOutlined />
            </Button>
          )}
          <div>
            <h1>{title}</h1>
            {!isRootPage(page) && gameName && page !== 'task' && <p>{gameName}</p>}
          </div>
          {isRootPage(page) && <span className="app-wordmark">存档同步</span>}
        </header>
        <main className="app-main" ref={main}>
          {error && (
            <div className="notice notice-error" role="alert">
              <p>{error}</p>
              <div className="action-row">
                <Button disabled={isBusy} onClick={onRetry}>
                  重试
                </Button>
                <Button fill="none" aria-label="关闭错误提示" onClick={onCloseError}>
                  <CloseOutlined />
                </Button>
              </div>
            </div>
          )}
          <div className="page-stack">{children}</div>
        </main>
        {footer}
        <nav className="bottom-nav" aria-label="主导航">
          {NAV.map((item) => (
            <button
              key={item.key}
              type="button"
              className={active === item.key ? 'active' : ''}
              aria-current={active === item.key ? 'page' : undefined}
              onClick={() => onNavigate(item.key)}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
      </div>
      {dialogs}
    </ConfigProvider>
  )
}
