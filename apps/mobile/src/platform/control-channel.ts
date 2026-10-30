import {
  isControlEventBody,
  isControlMessage,
  isControlRequestBody,
  isOpaqueId,
  isOperationResult,
} from '@savedata-sync/shared'
import type {
  ControlEventBodies,
  ControlEventMethod,
  ControlMessage,
  ControlRequestBodies,
  ControlRequestMethod,
  ControlResponseValues,
  OperationResult,
} from '@savedata-sync/shared'
import type { HttpTransferNativePlugin } from './http-transfer-bridge'

/** 原生连接状态；code 是最近一次关闭码，打开时为 0。 */
export interface ControlState {
  readonly isOpen: boolean
  readonly code: number
}
/** 本机断开设备时电脑使用的关闭码；收到后不再等待重连。 */
export const CONTROL_CLOSE_DISCONNECTED = 4001

type RequestHandler<M extends ControlRequestMethod> = (
  deviceId: string,
  body: ControlRequestBodies[M],
) => Promise<OperationResult<ControlResponseValues[M]>>
type EventHandler<M extends ControlEventMethod> = (
  deviceId: string,
  body: ControlEventBodies[M],
) => void

/** 与已连接设备的控制通道；消息由原生转发，这里按共享格式逐项校验后分发。 */
export interface AndroidControlApi {
  state(deviceId: string): ControlState | undefined
  /** 同一方法只保留最后注册的处理器；返回的函数撤销注册。 */
  onRequest<M extends ControlRequestMethod>(method: M, handler: RequestHandler<M>): () => void
  onEvent<M extends ControlEventMethod>(method: M, handler: EventHandler<M>): () => void
  onState(listener: (deviceId: string, state: ControlState) => void): () => void
  /** 通知对方；未连接时失败，事件不保证送达。 */
  emit<M extends ControlEventMethod>(
    deviceId: string,
    method: M,
    body: ControlEventBodies[M],
  ): Promise<void>
}

function failure(code: 'invalid-request' | 'unsupported-operation', message: string) {
  return { status: 'error', error: { code, message, canRetry: false } } as const
}

export function createControlChannel(
  plugin: HttpTransferNativePlugin,
  isAndroid: () => boolean,
): AndroidControlApi {
  const states = new Map<string, ControlState>()
  const requests = new Map<ControlRequestMethod, RequestHandler<ControlRequestMethod>>()
  const events = new Map<ControlEventMethod, Set<EventHandler<ControlEventMethod>>>()
  const stateListeners = new Set<(deviceId: string, state: ControlState) => void>()
  async function send(deviceId: string, message: ControlMessage): Promise<void> {
    const result = await plugin.sendControl({ deviceId, message: JSON.stringify(message) })
    if (!isOperationResult(result, (value): value is null => value === null)) {
      throw new Error('控制消息发送结果无效。')
    }
    if (result.status === 'error') {
      throw new Error(result.error.message)
    }
  }
  async function receive(deviceId: string, text: string): Promise<void> {
    let message: unknown
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    if (!isControlMessage(message)) {
      return
    }
    if (message.type === 'request') {
      const handler = requests.get(message.method)
      const result = !isControlRequestBody(message.method, message.body)
        ? failure('invalid-request', '请求格式无效。')
        : handler
          ? await handler(deviceId, message.body).catch((cause: unknown) => ({
              status: 'error' as const,
              error: {
                code: 'io-failure' as const,
                message: cause instanceof Error ? cause.message : '手机处理请求失败。',
                canRetry: false,
              },
            }))
          : failure('unsupported-operation', '手机不处理这个请求。')
      await send(deviceId, { v: 1, type: 'response', id: message.id, result })
    } else if (message.type === 'event' && isControlEventBody(message.method, message.body)) {
      for (const handler of events.get(message.method) ?? []) {
        handler(deviceId, message.body)
      }
    }
  }
  function changed(deviceId: string, state: ControlState): void {
    states.set(deviceId, state)
    for (const listener of stateListeners) {
      listener(deviceId, state)
    }
  }
  if (isAndroid()) {
    plugin
      .addListener('controlMessage', (event: unknown) => {
        if (
          typeof event === 'object' &&
          event !== null &&
          'deviceId' in event &&
          'message' in event &&
          isOpaqueId(event.deviceId) &&
          typeof event.message === 'string'
        ) {
          receive(event.deviceId, event.message).catch(() => undefined)
        }
      })
      .catch(() => undefined)
    plugin
      .addListener('controlState', (event: unknown) => {
        if (
          typeof event === 'object' &&
          event !== null &&
          'deviceId' in event &&
          'isOpen' in event &&
          'code' in event &&
          isOpaqueId(event.deviceId) &&
          typeof event.isOpen === 'boolean' &&
          typeof event.code === 'number'
        ) {
          changed(event.deviceId, { isOpen: event.isOpen, code: event.code })
        }
      })
      .catch(() => undefined)
    // 网页重载后连接仍由原生持有，先取一次当前状态。
    plugin
      .controlStates()
      .then((result) => {
        const isList = (
          value: unknown,
        ): value is readonly { deviceId: string; isOpen: boolean }[] =>
          Array.isArray(value) &&
          value.every(
            (item: unknown) =>
              typeof item === 'object' &&
              item !== null &&
              'deviceId' in item &&
              'isOpen' in item &&
              isOpaqueId(item.deviceId) &&
              typeof item.isOpen === 'boolean',
          )
        if (isOperationResult(result, isList) && result.status === 'success') {
          for (const item of result.value) {
            if (!states.has(item.deviceId)) {
              changed(item.deviceId, { isOpen: item.isOpen, code: 0 })
            }
          }
        }
      })
      .catch(() => undefined)
  }
  return {
    state: (deviceId) => states.get(deviceId),
    onRequest(method, handler) {
      const value = handler as unknown as RequestHandler<ControlRequestMethod>
      requests.set(method, value)
      return () => {
        if (requests.get(method) === value) {
          requests.delete(method)
        }
      }
    },
    onEvent(method, handler) {
      const value = handler as unknown as EventHandler<ControlEventMethod>
      const set = events.get(method) ?? new Set()
      set.add(value)
      events.set(method, set)
      return () => set.delete(value)
    },
    onState(listener) {
      stateListeners.add(listener)
      return () => stateListeners.delete(listener)
    },
    emit: (deviceId, method, body) =>
      isAndroid()
        ? send(deviceId, { v: 1, type: 'event', method, body })
        : Promise.reject(new Error('请在 Android 应用中操作。')),
  }
}
