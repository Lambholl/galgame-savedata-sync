import { createElement, useCallback, useRef } from 'react'
import type { ReactElement } from 'react'
import { message } from 'antd'
import type { ShownError } from '@savedata-sync/shared'
import { ErrorText } from '@savedata-sync/shared/ui'

/** 显示失败；传 null 表示操作已恢复正常，之后同样的失败会再提示一次。 */
export type ShowFailure = (failure: ShownError | null, context?: string | null) => void

/**
 * 页面的失败信息用 Message 提示一次，不在页面里放横幅。
 * 同一个失败连续出现（例如轮询每次都失败）只提示一次，直到传入 null 或换了别的失败。
 * 返回的元素放进页面，提供 Message 所需的主题与语言上下文。
 */
export function useFailureMessage(): readonly [ShowFailure, ReactElement] {
  const [api, holder] = message.useMessage()
  const last = useRef<string | null>(null)
  const show = useCallback<ShowFailure>(
    (failure, context = null) => {
      const signature = failure && `${context ?? ''}/${failure.code ?? ''}/${failure.message}`
      if (failure && signature && signature !== last.current) {
        void api.error({
          content: createElement(ErrorText, { error: failure, context }),
          key: signature,
          duration: 4,
        })
      }
      last.current = signature
    },
    [api],
  )
  return [show, holder]
}
