import { useState } from 'react'
import { toShownError } from '@savedata-sync/shared'
import { ErrorText, TaskTechnicalDetails, useT } from '@savedata-sync/shared/ui'
import { useAppMessage } from '../../app/app-message'

/** 桌面技术详情卡片的输入。 */
export interface TechnicalDetailsProps {
  /** 原样显示和复制的完整技术信息。 */
  readonly text: string
}

/** 桌面端保存展开状态，并负责写入系统剪贴板；复制不会改变展开状态。 */
export function TechnicalDetails({ text }: TechnicalDetailsProps): React.JSX.Element {
  const t = useT()
  const [isExpanded, setIsExpanded] = useState(false)
  const [appMessage, contextHolder] = useAppMessage()
  function copy(): void {
    async function write(): Promise<void> {
      await navigator.clipboard.writeText(text)
      appMessage.show({ type: 'success', content: t('common.copied') })
    }
    write().catch((cause: unknown) => {
      appMessage.show({
        type: 'error',
        content: <ErrorText error={toShownError(cause)} context={t('common.copyFailed')} />,
      })
    })
  }
  return (
    <>
      {contextHolder}
      <TaskTechnicalDetails
        text={text}
        isExpanded={isExpanded}
        interaction="pointer"
        onExpandedChange={setIsExpanded}
        onCopy={copy}
      />
    </>
  )
}
