import { useMemo, useRef } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { message } from 'antd'

/** 一条提示的内容。 */
export interface AppMessageOptions {
  readonly type: 'info' | 'success' | 'warning' | 'error'
  readonly content: ReactNode
  /** 显示秒数；不传时用 antd 默认值。 */
  readonly duration?: number
  /** 同一 slot 同时只留一条，新提示直接替换旧提示。 */
  readonly slot?: string
}

/** 应用内所有 Message 的入口；其他文件不直接用 antd 的 message，由 ESLint 检查。 */
export interface AppMessage {
  show(options: AppMessageOptions): void
  close(slot: string): void
}

let lastKey = 0

/**
 * 每条提示都用新的 key。用同一个 key 重开正在退场的提示时，antd 会复用旧实例，
 * 而它的计时已经结束且不会重启，提示就一直留在屏幕上。
 * 返回的元素放进页面，提供 Message 所需的主题与语言上下文。
 */
export function useAppMessage(): readonly [AppMessage, ReactElement] {
  const [api, holder] = message.useMessage()
  const slots = useRef(new Map<string, string>())
  const appMessage = useMemo<AppMessage>(
    () => ({
      show({ type, content, duration, slot }) {
        lastKey += 1
        const key = `app-message-${lastKey}`
        if (slot !== undefined) {
          const previous = slots.current.get(slot)
          if (previous !== undefined) {
            api.destroy(previous)
          }
          slots.current.set(slot, key)
        }
        void api.open({
          type,
          content,
          key,
          ...(duration === undefined ? {} : { duration }),
          // 触屏点一下提示会模拟 mouseenter，却没有对应的 mouseleave，计时会一直暂停。
          pauseOnHover: false,
          onClose() {
            if (slot !== undefined && slots.current.get(slot) === key) {
              slots.current.delete(slot)
            }
          },
        })
      },
      close(slot) {
        const key = slots.current.get(slot)
        if (key !== undefined) {
          api.destroy(key)
          slots.current.delete(slot)
        }
      },
    }),
    [api],
  )
  return [appMessage, holder]
}
