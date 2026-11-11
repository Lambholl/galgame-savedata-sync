import { useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { Button, ConfigProvider } from 'antd-mobile'
import admEnUS from 'antd-mobile/es/locales/en-US'
import admJaJP from 'antd-mobile/es/locales/ja-JP'
import admZhCN from 'antd-mobile/es/locales/zh-CN'
import admZhTW from 'antd-mobile/es/locales/zh-TW'
import type { AppLocale } from '@savedata-sync/shared'
import { useLocale, useT } from '@savedata-sync/shared/ui'
import type { NavigationDirection } from '@savedata-sync/shared/ui'
import {
  AppstoreOutlined,
  ArrowLeftOutlined,
  DesktopOutlined,
  SettingOutlined,
} from '@ant-design/icons'
import { isRootPage } from '../app/navigation-types'
import type { Page } from '../app/navigation-types'
import { PageSlide } from './PageSlide'

const NAV = [
  { key: 'devices', label: 'nav.devices', icon: <DesktopOutlined /> },
  { key: 'games', label: 'nav.games', icon: <AppstoreOutlined /> },
  { key: 'settings', label: 'nav.settings', icon: <SettingOutlined /> },
] as const

const LATERAL_ORDER: readonly Page[] = NAV.map((item) => item.key)

/** 右下角有悬浮主操作的页面，正文末尾留出按钮的高度。 */
const WITH_ACTION: readonly Page[] = ['sync', 'sync-plan', 'task', 'restore']

/** 大屏上内容放得下更多列的页面：游戏网格和两列文件比较，正文最大宽度放宽。 */
const WIDE: readonly Page[] = ['games', 'sync']

const ADM_LOCALES = {
  'zh-CN': admZhCN,
  'zh-TW': admZhTW,
  'en-US': admEnUS,
  'ja-JP': admJaJP,
} satisfies Record<AppLocale, unknown>

/** 移动应用的框架：主题和语言、标题栏、主导航和切页动画。 */
export function LibraryShell({
  page,
  title,
  gameName,
  hasBack,
  direction,
  footer,
  headerAction,
  dialogs,
  onBack,
  onNavigate,
  children,
}: {
  readonly page: Page
  readonly title: string
  readonly gameName: string | null
  /** 有来源页时显示返回按钮并隐藏主导航。 */
  readonly hasBack: boolean
  /** 切到当前页的方式，决定切页动画的方向。 */
  readonly direction: NavigationDirection
  readonly footer: ReactNode
  /** 标题栏右侧的页面操作（如“更多”菜单按钮）。 */
  readonly headerAction: ReactNode
  readonly dialogs: ReactNode
  readonly onBack: () => void
  readonly onNavigate: (page: Page) => void
  readonly children: ReactNode
}): React.JSX.Element {
  const t = useT()
  const locale = useLocale()
  const active = page === 'devices' || page === 'settings' ? page : 'games'
  const main = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    main.current?.scrollTo({ top: 0 })
  }, [page])
  return (
    <ConfigProvider locale={ADM_LOCALES[locale]}>
      <PageSlide
        page={page}
        direction={direction}
        lateralOrder={LATERAL_ORDER}
        nav={
          !hasBack && (
            <nav className="main-nav" aria-label={t('nav.main')}>
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
          )
        }
      >
        <header className="app-heading">
          {hasBack && (
            <Button fill="none" aria-label={t('nav.back')} onClick={onBack}>
              <ArrowLeftOutlined />
            </Button>
          )}
          <div>
            <h1>{title}</h1>
            {/* 游戏设置页正文就是可编辑的游戏名，不在标题下重复。 */}
            {!isRootPage(page) && gameName && page !== 'task' && page !== 'edit' && (
              <p>{gameName}</p>
            )}
          </div>
          {!hasBack && !headerAction && <span className="app-wordmark">{t('app.name')}</span>}
          {headerAction}
        </header>
        <main
          className={`app-main${hasBack ? '' : ' app-main-with-nav'}${WITH_ACTION.includes(page) ? ' app-main-with-action' : ''}${page === 'sync' ? ' app-main-fill' : ''}${WIDE.includes(page) ? ' app-main-wide' : ''}`}
          ref={main}
        >
          <div className="page-stack">{children}</div>
        </main>
        {footer}
      </PageSlide>
      {dialogs}
    </ConfigProvider>
  )
}
