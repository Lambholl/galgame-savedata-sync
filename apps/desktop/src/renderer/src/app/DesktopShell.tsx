import type { ReactNode } from 'react'
import { Button, ConfigProvider, Menu } from 'antd'
import antdEnUS from 'antd/locale/en_US'
import antdJaJP from 'antd/locale/ja_JP'
import antdZhCN from 'antd/locale/zh_CN'
import antdZhTW from 'antd/locale/zh_TW'
import type { Locale } from 'antd/es/locale'
import { DESIGN_BUTTON, designTheme, useLocale, useT } from '@savedata-sync/shared/ui'
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
  headerAction,
  dialogs,
  onBack,
  onNavigate,
  children,
}: {
  readonly theme: ResolvedTheme
  readonly page: Page
  readonly title: string
  readonly gameName: string | null
  /** 标题栏右侧的页面操作（如传输页的游戏设置、备份入口）。 */
  readonly headerAction: ReactNode
  readonly dialogs: ReactNode
  readonly onBack: () => void
  readonly onNavigate: (page: Page) => void
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
      theme={designTheme(resolvedTheme, 'desktop')}
      button={DESIGN_BUTTON}
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
            {t('settings.version')} <span className="ss-copyable">{APP_VERSION}</span>
          </small>
        </aside>
        <div className="library-surface">
          <header className="library-header">
            {isNestedPage && (
              <Button
                type="text"
                className="library-back"
                aria-label={t('nav.backToGames')}
                icon={<ArrowLeftOutlined />}
                onClick={onBack}
              />
            )}
            <div className="library-header-title">
              <h1>{title}</h1>
              {/* 游戏设置页正文就是可编辑的游戏名，不在标题下重复。 */}
              {gameName && isNestedPage && page !== 'task' && page !== 'edit' && <p>{gameName}</p>}
            </div>
            {headerAction && <div className="library-header-actions">{headerAction}</div>}
          </header>
          {/* 传输页铺满窗口高度：两列文件各自滚动，状态栏贴在底部。 */}
          <main className={`library-main${page === 'transfer' ? ' is-fill' : ''}`}>
            <div className="library-stack">{children}</div>
          </main>
        </div>
      </div>
      {dialogs}
    </ConfigProvider>
  )
}
