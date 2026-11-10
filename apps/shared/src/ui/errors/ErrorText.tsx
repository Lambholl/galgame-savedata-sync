import type { ReactElement } from 'react'
import type { ShownError } from '../../result.ts'
import { useT } from '../i18n/i18n-context.ts'
import { errorDetail } from './error-detail.ts'
import { useLocalDevice } from './local-device-context.ts'

/** ErrorText 的参数。字号与颜色继承所在位置。 */
export interface ErrorTextProps {
  /** 要显示的错误；由 toShownError 从捕获的异常得到，或直接传入任务结果里的错误。 */
  readonly error: ShownError
  /** 出错的操作，例如“读取备份失败”，写在说明前；不需要时为 null。 */
  readonly context: string | null
}

/**
 * 显示一个错误：有错误码时只显示该错误码的本地化说明，没有错误码时原样显示消息；
 * 知道出错的一端时在说明前写“本机”或“对方设备”，按 LocalDeviceProvider 提供的本机设备种类判断。
 * 界面上不放“详情”开关：原始消息与错误码在电脑上悬停可见，任务详情里写进技术详情卡片。
 */
export function ErrorText({ error, context }: ErrorTextProps): ReactElement {
  const t = useT()
  const localDevice = useLocalDevice()
  const description = error.code ? t(`error.code.${error.code}`) : error.message
  const text =
    error.device === undefined
      ? description
      : t(error.device === localDevice ? 'error.onLocal' : 'error.onRemote', { text: description })
  return (
    <span className="ss-error" title={error.code ? errorDetail(error) : undefined}>
      {error.code && context ? t('error.withContext', { context, text }) : text}
    </span>
  )
}
