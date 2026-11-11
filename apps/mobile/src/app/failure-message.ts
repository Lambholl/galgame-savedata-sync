import { createElement, useCallback, useRef } from 'react'
import type { ReactElement } from 'react'
import type { ShownError } from '@savedata-sync/shared'
import { ErrorText } from '@savedata-sync/shared/ui'
import { useAppMessage } from './app-message'

/** 显示失败；传 null 表示操作已恢复正常，之后同样的失败会再提示一次。 */
export type ShowFailure = (failure: ShownError | null, context?: string | null) => void

/**
 * 用全局提示显示失败。同一个失败连续出现时只提示一次，直到传入 null 或换了别的失败。
 *
 * @returns 显示失败的函数，以及需要放进页面的上下文元素。
 */
export function useFailureMessage(): readonly [ShowFailure, ReactElement] {
  const [appMessage, holder] = useAppMessage()
  const last = useRef<string | null>(null)
  const show = useCallback<ShowFailure>(
    (failure, context = null) => {
      const signature =
        failure &&
        `${context ?? ''}/${failure.device ?? ''}/${failure.code ?? ''}/${failure.message}`
      if (failure && signature && signature !== last.current) {
        appMessage.show({
          type: 'error',
          content: createElement(ErrorText, { error: failure, context }),
          slot: signature,
          duration: 4,
        })
      }
      last.current = signature
    },
    [appMessage],
  )
  return [show, holder]
}
