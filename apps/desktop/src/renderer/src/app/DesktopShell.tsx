import type { ReactNode } from 'react'
import { Alert, Button, ConfigProvider, Menu, theme } from 'antd'
import antdEnUS from 'antd/locale/en_US'
import antdJaJP from 'antd/locale/ja_JP'
import antdZhCN from 'antd/locale/zh_CN'
import antdZhTW from 'antd/locale/zh_TW'
import type { Locale } from 'antd/es/locale'
import { useLocale, useT } from '@savedata-sync/shared/ui'
import { APP_VERSION } from '@savedata-sync/shared'
import type { AppLocale } from '@savedata-sync/shared'
import {
  AppstoreOutlined,
  ArrowLeftOutlined,
  DesktopOutlined,
  SettingOutlined,
} from '@ant-design/icons'
import appLogo from '../../../../../../assets/app-logo.png'
import { isRootPage } from './navigation.ts'
import type { Page } from './navigation.ts'
import { themeTokens } from '@savedata-sync/shared'
import type { ResolvedTheme } from '@savedata-sync/shared'

const NAV = [
  { key: 'devices', label: 'nav.devices', icon: <DesktopOutlined /> },
  { key: 'games', label: 'nav.games', icon: <AppstoreOutlined /> },
  { key: 'settings', label: 'nav.settings', icon: <SettingOutlined /> },
] as const

const ANTD_LOCALES: Readonly<Record<AppLocale, Locale>> = {
  'zh-CN': antdZhCN,
  'zh-TW': antdZhTW,
  'en-US': antdEnUS,
  'ja-JP': antdJaJP,
}

export function DesktopShell({
  theme: resolvedTheme,
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
  readonly theme: ResolvedTheme
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
  const isDark = resolvedTheme === 'dark'
  const t = useT()
  const locale = useLocale()
  return (
    <ConfigProvider
      locale={ANTD_LOCALES[locale]}
      theme={{
        algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: themeTokens(resolvedTheme),
        components: { Card: { bodyPadding: 20 } },
      }}
    >
      <div className={`library-app library-desktop ${isDark ? 'library-dark' : ''}`}>
        <aside className="library-sidebar">
          <div className="library-brand">
            <img src={appLogo} alt="" width={64} height={64} />
            <span>{t('app.name')}</span>
          </div>
          <Menu
            mode="inline"
            selectedKeys={[activeNav]}
            items={NAV.map((item) => ({ ...item, label: t(item.label) }))}
            onClick={({ key }) => onNavigate(key as Page)}
          />
          <small>
            {t('settings.version')} {APP_VERSION}
          </small>
        </aside>
        <div className="library-surface">
          <header className="library-header">
            <div>
              {isNestedPage && (
                <Button icon={<ArrowLeftOutlined />} onClick={onBack}>
                  {t('nav.games')}
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
                    {t('common.retry')}
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
