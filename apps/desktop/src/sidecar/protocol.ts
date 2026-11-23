import type { ThemePreference } from '@savedata-sync/shared'

// sidecar 和宿主之间的消息。双方每行写一条 UTF-8 JSON：
// 宿主发给 sidecar 的消息走 sidecar 的 stdin，sidecar 发给宿主的走 stdout，stderr 只写日志。

/** 宿主转发的界面请求；channel 是 bridge 里的通道名，args 是界面传入的参数。 */
export interface InvokeMessage {
  readonly type: 'invoke'
  readonly id: number
  readonly channel: string
  readonly args: readonly unknown[]
}

/** 宿主要求停止全部服务；成功后 sidecar 退出进程。 */
export interface ShutdownMessage {
  readonly type: 'shutdown'
  readonly id: number
}

/** 宿主对 HostRequestMessage 的应答；error 是失败原因，有 error 时忽略 value。 */
export interface HostResultMessage {
  readonly type: 'host-result'
  readonly id: number
  readonly value?: unknown
  readonly error?: string
}

/** 宿主发给 sidecar 的消息。 */
export type HostToSidecarMessage = InvokeMessage | ShutdownMessage | HostResultMessage

/** 后端初始化完成，可以打开窗口。文字都已按语言偏好翻译。 */
export interface ReadyMessage {
  readonly type: 'ready'
  /** 窗口标题。 */
  readonly title: string
  /** 浅色和深色主题下窗口的背景色，格式 `#rrggbb`。 */
  readonly backgroundColors: { readonly light: string; readonly dark: string }
  /** sidecar 意外退出时宿主显示的提示标题和内容。 */
  readonly stoppedTitle: string
  readonly stoppedMessage: string
}

/** 后端初始化失败，sidecar 发出后以退出码 1 退出；title 和 message 可以直接显示给用户。 */
export interface FatalMessage {
  readonly type: 'fatal'
  readonly title: string
  readonly message: string
}

/** InvokeMessage 的结果；value 是通道处理函数的返回值。 */
export interface InvokeResultMessage {
  readonly type: 'result'
  readonly id: number
  readonly value: unknown
}

/**
 * ShutdownMessage 的结果。isStopped 为 true 时 sidecar 随后退出；
 * 为 false 时服务没有全部释放，sidecar 继续运行，title 和 message 可以直接显示给用户，宿主可以再次请求停止。
 */
export interface ShutdownResultMessage {
  readonly type: 'shutdown-result'
  readonly id: number
  readonly isStopped: boolean
  readonly title?: string
  readonly message?: string
}

/** sidecar 请求宿主提供的平台能力，见 HostRequest。 */
export type HostRequestMessage = {
  readonly type: 'host-request'
  readonly id: number
} & HostRequest

/**
 * sidecar 请求宿主做的事和应答的 value：
 * chooseDirectory 和 chooseImageFile 返回选中的绝对路径，取消时为 null；openPath 和 setTheme 返回 null。
 */
export type HostRequest =
  | { readonly method: 'chooseDirectory'; readonly params: { readonly title: string } }
  | { readonly method: 'chooseImageFile'; readonly params: { readonly title: string } }
  | { readonly method: 'openPath'; readonly params: { readonly path: string } }
  | { readonly method: 'setTheme'; readonly params: { readonly theme: ThemePreference } }

/** sidecar 发给宿主的消息。 */
export type SidecarToHostMessage =
  ReadyMessage | FatalMessage | InvokeResultMessage | ShutdownResultMessage | HostRequestMessage

function isMessageId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * 解析宿主发来的一行。
 *
 * @returns 格式不对时返回 null。
 */
export function parseHostMessage(line: string): HostToSidecarMessage | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const message = value as Record<string, unknown>
  if (!isMessageId(message.id)) {
    return null
  }
  if (message.type === 'invoke') {
    return typeof message.channel === 'string' && Array.isArray(message.args)
      ? { type: 'invoke', id: message.id, channel: message.channel, args: message.args }
      : null
  }
  if (message.type === 'shutdown') {
    return { type: 'shutdown', id: message.id }
  }
  if (message.type === 'host-result') {
    if (message.error !== undefined && typeof message.error !== 'string') {
      return null
    }
    return {
      type: 'host-result',
      id: message.id,
      value: message.value,
      ...(message.error === undefined ? {} : { error: message.error }),
    }
  }
  return null
}
