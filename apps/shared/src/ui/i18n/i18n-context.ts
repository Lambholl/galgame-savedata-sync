import { createContext, useContext } from 'react'
import { createTranslator } from '../../i18n/translate.ts'
import type { Translate } from '../../i18n/translate.ts'
import type { AppLocale } from '../../preferences/app-preferences.ts'

/** 当前界面语言与对应的取文案函数。 */
export interface I18nValue {
  readonly locale: AppLocale
  readonly t: Translate
}

export const i18nContext = createContext<I18nValue>({
  locale: 'zh-CN',
  t: createTranslator('zh-CN'),
})

/** 取当前语言的文案函数。 */
export function useT(): Translate {
  return useContext(i18nContext).t
}

/** 取当前界面语言，用于日期与数字格式化。 */
export function useLocale(): AppLocale {
  return useContext(i18nContext).locale
}
