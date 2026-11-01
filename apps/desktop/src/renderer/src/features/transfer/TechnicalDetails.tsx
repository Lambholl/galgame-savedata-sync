import { useState } from 'react'
import { message } from 'antd'
import { toShownError } from '@savedata-sync/shared'
import { ErrorText, TaskTechnicalDetails, useT } from '@savedata-sync/shared/ui'

/** 桌面技术详情卡片的输入。 */
export interface TechnicalDetailsProps {
  /** 原样显示和复制的完整技术信息。 */
  readonly text: string
}

/** 桌面端保存展开状态，并负责写入系统剪贴板；复制不会改变展开状态。 */
export function TechnicalDetails({ text }: TechnicalDetailsProps): React.JSX.Element {
  const t = useT()
  const [isExpanded, setIsExpanded] = useState(false)
  const [messageApi, contextHolder] = message.useMessage()
  function copy(): void {
    async function write(): Promise<void> {
      await navigator.clipboard.writeText(text)
      void messageApi.success(t('common.copied'))
    }
    write().catch((cause: unknown) => {
      void messageApi.error({
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
