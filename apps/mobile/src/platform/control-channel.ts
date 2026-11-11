import {
  isControlEventBody,
  isControlMessage,
  isControlRequestBody,
  isOpaqueId,
  isOperationResult,
  OperationFailure,
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
/** 对方主动断开时使用的关闭码，表示不要再等待重连。 */
export const CONTROL_CLOSE_DISCONNECTED = 4001

type RequestHandler<M extends ControlRequestMethod> = (
  deviceId: string,
  body: ControlRequestBodies[M],
) => Promise<OperationResult<ControlResponseValues[M]>>
type EventHandler<M extends ControlEventMethod> = (
  deviceId: string,
  body: ControlEventBodies[M],
) => void

/** 与已连接设备的控制通道；收到的消息按共享格式校验后分发，格式不对的消息丢弃。 */
export interface AndroidControlApi {
  /** 读取与这台设备的连接状态；从没收到过它的状态时为 undefined。 */
  state(deviceId: string): ControlState | undefined
  /** 同一方法只保留最后注册的处理器；返回的函数撤销注册。 */
  onRequest<M extends ControlRequestMethod>(method: M, handler: RequestHandler<M>): () => void
  /** 订阅一种事件，同一事件可以有多个处理器；返回的函数撤销订阅。 */
  onEvent<M extends ControlEventMethod>(method: M, handler: EventHandler<M>): () => void
  /** 订阅连接状态变化；返回的函数撤销订阅。 */
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

/** 用传输插件创建控制通道；isAndroid 返回 false 时 emit 失败、不会收到消息。 */
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
      throw new OperationFailure('io-failure', 'The control message send result is invalid.')
    }
    if (result.status === 'error') {
      throw new OperationFailure(result.error.code, result.error.message)
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
        ? failure('invalid-request', 'The request format is invalid.')
        : handler
          ? await handler(deviceId, message.body).catch((cause: unknown) => ({
              status: 'error' as const,
              error: {
                code: 'io-failure' as const,
                message:
                  cause instanceof Error
                    ? cause.message
                    : 'The mobile device failed to process the request.',
                canRetry: false,
              },
            }))
          : failure('unsupported-operation', 'The mobile device does not handle this request.')
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
    // 网页重载后连接仍然存在，先取一次当前状态。
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
        : Promise.reject(
            new OperationFailure(
              'unsupported-operation',
              'Perform this operation in the Android app.',
            ),
          ),
  }
}
