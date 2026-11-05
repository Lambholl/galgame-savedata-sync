import { useEffect, useRef, useState } from 'react'
import type { MouseEvent, PointerEvent } from 'react'
import { toShownError } from '@savedata-sync/shared'
import { ErrorText, TaskTechnicalDetails, useT } from '@savedata-sync/shared/ui'
import { useAppMessage } from '../../app/app-message'

/** 移动端技术详情卡片的输入。 */
export interface TechnicalDetailsProps {
  /** 原样显示和复制的完整技术信息。 */
  readonly text: string
}

/** 短按展开或收起，长按复制全部；移动、滚动、取消操作以及组件卸载都会取消长按计时。 */
export function TechnicalDetails({ text }: TechnicalDetailsProps): React.JSX.Element {
  const t = useT()
  const [isExpanded, setIsExpanded] = useState(false)
  const [appMessage, contextHolder] = useAppMessage()
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
  function copy(value: string): void {
    async function write(): Promise<void> {
      await navigator.clipboard.writeText(value)
      appMessage.show({ type: 'success', content: t('common.copied') })
    }
    write().catch((cause: unknown) => {
      appMessage.show({
        type: 'error',
        content: <ErrorText error={toShownError(cause)} context={t('common.copyFailed')} />,
      })
    })
  }
  function stop(): void {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
    origin.current = null
  }
  function press(event: PointerEvent<HTMLDivElement>): void {
    stop()
    didLongPress.current = false
    if (!event.isPrimary || event.button !== 0) {
      return
    }
    origin.current = { x: event.clientX, y: event.clientY }
    timer.current = setTimeout(() => {
      timer.current = null
      didLongPress.current = true
      copy(text)
    }, 500)
  }
  function move(event: PointerEvent<HTMLDivElement>): void {
    const start = origin.current
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) {
      stop()
    }
  }
  function click(event: MouseEvent<HTMLDivElement>): void {
    event.preventDefault()
    event.stopPropagation()
    if (didLongPress.current && event.detail !== 0) {
      didLongPress.current = false
      return
    }
    setIsExpanded((isOpen) => !isOpen)
  }
  function contextMenu(event: MouseEvent<HTMLDivElement>): void {
    event.preventDefault()
    stop()
    if (!didLongPress.current) {
      didLongPress.current = true
      copy(text)
    }
  }
  return (
    <>
      {contextHolder}
      <div
        className="ss-tech-touch-card"
        onPointerDown={press}
        onPointerMove={move}
        onPointerUp={stop}
        onPointerCancel={stop}
        onPointerLeave={stop}
        onClickCapture={click}
        onContextMenu={contextMenu}
      >
        <TaskTechnicalDetails
          text={text}
          isExpanded={isExpanded}
          interaction="touch"
          onExpandedChange={setIsExpanded}
          onCopy={() => copy(text)}
        />
      </div>
    </>
  )
}
