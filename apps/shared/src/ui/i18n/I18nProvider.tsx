import { useMemo, type ReactElement, type ReactNode } from 'react'
import { createTranslator } from '../../i18n/translate.ts'
import type { AppLocale } from '../../preferences/app-preferences.ts'
import { i18nContext } from './i18n-context.ts'

/** I18nProvider 的参数。 */
export interface I18nProviderProps {
  /** 界面语言。 */
  readonly locale: AppLocale
  /** 使用这种语言显示的界面。 */
  readonly children: ReactNode
}

/** 向子组件提供界面语言和对应的 Translate 函数。 */
export function I18nProvider({ locale, children }: I18nProviderProps): ReactElement {
  const value = useMemo(() => ({ locale, t: createTranslator(locale) }), [locale])
  return <i18nContext.Provider value={value}>{children}</i18nContext.Provider>
}
