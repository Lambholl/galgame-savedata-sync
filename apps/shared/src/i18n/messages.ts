import type { zhCN } from './messages/zh-CN.ts'

type Base = typeof zhCN

/** 所有文案键。 */
export type MessageKey = keyof Base

/** 一种语言的完整文案表：键与 zh-CN 相同，函数条目的参数也相同。 */
export type Messages = {
  readonly [K in MessageKey]: Base[K] extends string ? string : Base[K]
}

/** 某个键需要的参数；纯文本条目的参数列表为空。 */
export type MessageArgs<K extends MessageKey> = Base[K] extends (params: infer P) => string
  ? [params: P]
  : []
