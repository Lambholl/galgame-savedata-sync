import { useEffect, useRef } from 'react'
import type { MouseEvent, PointerEvent } from 'react'

/** 绑在长按区域外层元素上的事件。 */
export interface LongPressHandlers {
  readonly onClickCapture: (event: MouseEvent<HTMLElement>) => void
  readonly onPointerDown: (event: PointerEvent<HTMLElement>) => void
  readonly onPointerMove: (event: PointerEvent<HTMLElement>) => void
  readonly onPointerUp: () => void
  readonly onPointerCancel: () => void
  readonly onPointerLeave: () => void
  readonly onContextMenu: (event: MouseEvent<HTMLElement>) => void
}

const HOLD_MS = 500
const MOVE_TOLERANCE_PX = 10

/**
 * 触控按住 500ms 或系统弹出右键菜单时执行长按动作；手指移动超过 10px（滚动）或取消触控时撤销计时。
 * 长按之后系统还会补发一次点击，这次点击被吞掉，否则点按动作会再执行一遍。
 * actionFor 在按下时根据按下的元素决定长按做什么，返回 null 表示这里不响应长按。
 */
export function useLongPress(
  actionFor: (target: Element) => (() => void) | null,
): LongPressHandlers {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const origin = useRef<{ x: number; y: number } | null>(null)
  const didLongPress = useRef(false)

  useEffect(
    () => () => {
      if (timer.current !== null) {
        clearTimeout(timer.current)
      }
    },
    [],
  )

  function cancel(): void {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
    origin.current = null
  }

  return {
    onClickCapture(event) {
      if (didLongPress.current && event.detail !== 0) {
        event.preventDefault()
        event.stopPropagation()
        didLongPress.current = false
      }
    },
    onPointerDown(event) {
      cancel()
      didLongPress.current = false
      const action = event.target instanceof Element ? actionFor(event.target) : null
      if (!action || event.pointerType === 'mouse' || !event.isPrimary || event.button !== 0) {
        return
      }
      origin.current = { x: event.clientX, y: event.clientY }
      timer.current = setTimeout(() => {
        timer.current = null
        didLongPress.current = true
        action()
      }, HOLD_MS)
    },
    onPointerMove(event) {
      const start = origin.current
      if (
        start &&
        Math.hypot(event.clientX - start.x, event.clientY - start.y) > MOVE_TOLERANCE_PX
      ) {
        cancel()
      }
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    onContextMenu(event) {
      const action = event.target instanceof Element ? actionFor(event.target) : null
      if (!action) {
        return
      }
      event.preventDefault()
      cancel()
      if (!didLongPress.current) {
        didLongPress.current = true
        action()
      }
    },
  }
}
