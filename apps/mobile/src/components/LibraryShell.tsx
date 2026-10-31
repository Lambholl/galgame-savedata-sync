import { useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { Button, ConfigProvider } from 'antd-mobile'
import admEnUS from 'antd-mobile/es/locales/en-US'
import admJaJP from 'antd-mobile/es/locales/ja-JP'
import admZhCN from 'antd-mobile/es/locales/zh-CN'
import admZhTW from 'antd-mobile/es/locales/zh-TW'
import type { AppLocale } from '@savedata-sync/shared'
import { useLocale, useT } from '@savedata-sync/shared/ui'
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
  { key: 'devices', label: 'nav.devices', icon: <DesktopOutlined /> },
  { key: 'games', label: 'nav.games', icon: <AppstoreOutlined /> },
  { key: 'settings', label: 'nav.settings', icon: <SettingOutlined /> },
] as const

const ADM_LOCALES = {
  'zh-CN': admZhCN,
  'zh-TW': admZhTW,
  'en-US': admEnUS,
  'ja-JP': admJaJP,
} satisfies Record<AppLocale, unknown>

export function LibraryShell({
  page,
  title,
  gameName,
  error,
  isBusy,
  footer,
  headerAction,
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
  /** 标题栏右侧的页面操作（如“更多”菜单按钮）。 */
  readonly headerAction: ReactNode
  readonly dialogs: ReactNode
  readonly onBack: () => void
  readonly onNavigate: (page: Page) => void
  readonly onCloseError: () => void
  readonly onRetry: () => void
  readonly children: ReactNode
}): React.JSX.Element {
  const t = useT()
  const locale = useLocale()
  const active = page === 'devices' || page === 'settings' ? page : 'games'
  const main = useRef<HTMLElement>(null)
  const previousPage = useRef(page)
  useLayoutEffect(() => {
    const element = main.current
    const previous = previousPage.current
    previousPage.current = page
    element?.scrollTo({ top: 0 })
    if (
      !element ||
      previous === page ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      return
    }
    const isMovingBack =
      (previous === 'sync-plan' && page === 'sync') ||
      (isRootPage(page) &&
        (!isRootPage(previous) ||
          NAV.findIndex((item) => item.key === page) <
            NAV.findIndex((item) => item.key === previous)))
    // 只对页面容器做动效，保留子组件状态；轮询刷新不会重新启动动画。
    const animation = element.animate(
      [
        { opacity: 0, transform: `translateX(${isMovingBack ? -12 : 12}px)` },
        { opacity: 1, transform: 'translateX(0)' },
      ],
      { duration: 300, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' },
    )
    return () => animation.cancel()
  }, [page])
  return (
    <ConfigProvider locale={ADM_LOCALES[locale]}>
      <div className="mobile-app">
        <header className="app-heading">
          {!isRootPage(page) && (
            <Button
              fill="none"
              aria-label={t(page === 'sync-plan' ? 'nav.backToTransfer' : 'nav.backToGames')}
              onClick={onBack}
            >
              <ArrowLeftOutlined />
            </Button>
          )}
          <div>
            <h1>{title}</h1>
            {!isRootPage(page) && gameName && page !== 'task' && <p>{gameName}</p>}
          </div>
          {isRootPage(page) && <span className="app-wordmark">{t('app.name')}</span>}
          {headerAction}
        </header>
        <main
          className={`app-main${page === 'sync' || page === 'sync-plan' ? ' app-main-with-action' : ''}`}
          ref={main}
        >
          {error && (
            <div className="notice notice-error" role="alert">
              <p>{error}</p>
              <div className="action-row">
                <Button disabled={isBusy} onClick={onRetry}>
                  {t('common.retry')}
                </Button>
                <Button fill="none" aria-label={t('common.closeError')} onClick={onCloseError}>
                  <CloseOutlined />
                </Button>
              </div>
            </div>
          )}
          <div className="page-stack">{children}</div>
        </main>
        {footer}
        {isRootPage(page) && (
          <nav className="bottom-nav" aria-label={t('nav.main')}>
            {NAV.map((item) => (
              <button
                key={item.key}
                type="button"
                className={active === item.key ? 'active' : ''}
                aria-current={active === item.key ? 'page' : undefined}
                onClick={() => onNavigate(item.key)}
              >
                {item.icon}
                <span>{t(item.label)}</span>
              </button>
            ))}
          </nav>
        )}
      </div>
      {dialogs}
    </ConfigProvider>
  )
}
