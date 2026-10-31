import { useMemo, type ReactElement, type ReactNode } from 'react'
import { createTranslator } from '../../i18n/translate.ts'
import type { AppLocale } from '../../preferences/app-preferences.ts'
import { i18nContext } from './i18n-context.ts'

/** I18nProvider 的参数。 */
export interface I18nProviderProps {
  /** 已解析的界面语言；由各端按偏好与系统语言决定。 */
  readonly locale: AppLocale
  /** 使用这种语言显示的界面。 */
  readonly children: ReactNode
}

/** 为其下的共用组件与两端页面提供当前语言。 */
export function I18nProvider({ locale, children }: I18nProviderProps): ReactElement {
  const value = useMemo(() => ({ locale, t: createTranslator(locale) }), [locale])
  return <i18nContext.Provider value={value}>{children}</i18nContext.Provider>
}
