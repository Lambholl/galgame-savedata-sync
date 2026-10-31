import type { AppLocale } from '../preferences/app-preferences.ts'
import type { MessageArgs, MessageKey, Messages } from './messages.ts'
import { enUS } from './messages/en-US.ts'
import { jaJP } from './messages/ja-JP.ts'
import { zhCN } from './messages/zh-CN.ts'
import { zhTW } from './messages/zh-TW.ts'

const CATALOGS: Readonly<Record<AppLocale, Messages>> = {
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  'en-US': enUS,
  'ja-JP': jaJP,
}

/** 语言选项名用各自的语言书写，不随界面语言变化。 */
export const LOCALE_NAMES: Readonly<Record<AppLocale, string>> = {
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  'en-US': 'English',
  'ja-JP': '日本語',
}

/** 按键取文案并带入参数。 */
export type Translate = <K extends MessageKey>(key: K, ...args: MessageArgs<K>) => string

export function createTranslator(locale: AppLocale): Translate {
  const messages = CATALOGS[locale]
  return <K extends MessageKey>(key: K, ...args: MessageArgs<K>): string => {
    const entry: unknown = messages[key]
    if (typeof entry === 'function') {
      return (entry as (params: unknown) => string)(args[0])
    }
    return entry as string
  }
}
