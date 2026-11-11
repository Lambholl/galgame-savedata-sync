import type { ReactElement } from 'react'
import type { ShownError } from '../../result.ts'
import { useT } from '../i18n/i18n-context.ts'
import { errorDetail } from './error-detail.ts'
import { useLocalDevice } from './local-device-context.ts'

/** ErrorText 的参数。 */
export interface ErrorTextProps {
  /** 要显示的错误。 */
  readonly error: ShownError
  /** 出错的操作，例如“读取备份失败”，写在说明前；不需要时为 null。 */
  readonly context: string | null
}

/**
 * 显示一个错误：有错误码时显示该错误码的本地化说明，没有错误码时显示原消息。
 * 知道出错的一端时，按 LocalDeviceProvider 提供的本机设备种类在说明前写“本机”或“对方设备”。
 * 有错误码时，原消息和错误码放在悬停提示里。字号和颜色继承所在位置。
 *
 * @throws Error 组件不在 LocalDeviceProvider 之下时抛出。
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
