import { WebSocket } from 'ws'
import type { RawData } from 'ws'
import {
  CONTROL_LIMITS,
  CONTROL_ROUTE,
  HTTP_HEADERS,
  SYNC_DEVICE_HEADER,
  isControlEventBody,
  isControlMessage,
  isControlRequestBody,
} from '@savedata-sync/shared'
import type {
  ControlEvent,
  ControlEventBodies,
  ControlEventMethod,
  ControlMessage,
  ControlRequestBodies,
  ControlRequestMethod,
  ControlResponseValues,
  OperationResult,
} from '@savedata-sync/shared'
import { HttpOperationError, toHttpError } from './http-errors.ts'
import { inspectJsonKeys } from './http-wire.ts'

/** 控制通道的回调。 */
export interface DialerControlEvents {
  /** 握手完成时调用。 */
  readonly opened: () => void
  /** 连接关闭或握手失败时调用一次；code 是关闭码，没收到关闭帧时为 1006。 */
  readonly closed: (code: number) => void
  /** 收到监听方的通知时调用。 */
  readonly event: <M extends ControlEventMethod>(method: M, body: ControlEventBodies[M]) => void
  /** 处理监听方的请求；返回值作为成功应答，抛错时按错误应答。 */
  readonly request: <M extends ControlRequestMethod>(
    method: M,
    body: ControlRequestBodies[M],
  ) => Promise<ControlResponseValues[M]>
}

/** 到监听方 `/v1/control` 的一条控制通道。关闭后实例不能再用，重连要新建实例。 */
export class DialerControlSocket {
  private readonly socket: WebSocket
  private readonly heartbeat: NodeJS.Timeout
  private isAlive = true
  private isClosed = false

  constructor(
    origin: string,
    sessionId: string,
    localDeviceId: string,
    private readonly events: DialerControlEvents,
  ) {
    const url = new URL(CONTROL_ROUTE, origin)
    url.protocol = 'ws:'
    this.socket = new WebSocket(url, {
      headers: { [HTTP_HEADERS.sessionId]: sessionId, [SYNC_DEVICE_HEADER]: localDeviceId },
      maxPayload: CONTROL_LIMITS.maxMessageBytes,
      perMessageDeflate: false,
      handshakeTimeout: 5000,
      followRedirects: false,
    })
    this.socket.on('open', () => {
      this.isAlive = true
      events.opened()
    })
    this.socket.on('pong', () => {
      this.isAlive = true
    })
    this.socket.on('message', (data, isBinary) => {
      if (isBinary) {
        this.socket.close(1003, 'text-only')
      } else {
        this.receive(data)
      }
    })
    // ws 的 error 事件没有监听时会成为未处理异常。握手失败（包括 403）也从这里来，之后 close 事件照常触发。
    this.socket.on('error', () => this.socket.terminate())
    this.socket.on('close', (code) => this.finish(code))
    // 对方断网时 TCP 可能很久不报错；一个 ping 间隔内没收到 pong 就终止，closed 才能及时触发重连。
    this.heartbeat = setInterval(() => {
      if (this.socket.readyState !== WebSocket.OPEN) {
        return
      }
      if (!this.isAlive) {
        this.socket.terminate()
        return
      }
      this.isAlive = false
      this.socket.ping()
    }, CONTROL_LIMITS.pingIntervalMs)
    this.heartbeat.unref()
  }

  /** 控制通道是否已打开。 */
  isOpen(): boolean {
    return !this.isClosed && this.socket.readyState === WebSocket.OPEN
  }

  /**
   * 向监听方发一条事件。
   *
   * @throws HttpOperationError 通道没打开时抛 network-failure，事件超过 8 MiB 时抛 resource-limit。
   */
  emit<M extends ControlEventMethod>(method: M, body: ControlEventBodies[M]): void {
    if (!this.isOpen()) {
      throw new HttpOperationError('network-failure', 'The control channel is not open.')
    }
    const event: ControlEvent<M> = { v: 1, type: 'event', method, body }
    this.send(event)
  }

  /** 关闭连接，关闭码 1000；握手还没完成时直接终止。已关闭时不做任何事。 */
  close(): void {
    if (this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.terminate()
    } else {
      this.socket.close(1000, 'closed')
    }
  }

  private finish(code: number): void {
    if (this.isClosed) {
      return
    }
    this.isClosed = true
    clearInterval(this.heartbeat)
    this.events.closed(code)
  }

  private send(message: ControlMessage): void {
    const text = JSON.stringify(message)
    if (Buffer.byteLength(text) > CONTROL_LIMITS.maxMessageBytes) {
      throw new HttpOperationError('resource-limit', 'The control message exceeds the limit.')
    }
    this.socket.send(text)
  }

  private receive(data: RawData): void {
    let message: unknown
    try {
      const bytes = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data)
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
      message = JSON.parse(text)
      inspectJsonKeys(text)
    } catch {
      this.socket.close(1007, 'invalid-json')
      return
    }
    if (!isControlMessage(message)) {
      this.socket.close(1008, 'invalid-message')
      return
    }
    if (message.type === 'response') {
      // 拨号方不向监听方发请求，应答直接丢弃。
      return
    }
    if (message.type === 'event') {
      if (!isControlEventBody(message.method, message.body)) {
        this.socket.close(1008, 'invalid-event')
        return
      }
      this.events.event(message.method, message.body)
      return
    }
    const { id, method, body } = message
    const answer = (result: OperationResult<unknown>): void => {
      if (this.isOpen()) {
        try {
          this.send({ v: 1, type: 'response', id, result })
        } catch {
          // 应答超过上限时改答错误，对方不会一直等到超时。
          this.send({
            v: 1,
            type: 'response',
            id,
            result: {
              status: 'error',
              error: {
                code: 'resource-limit',
                message: 'The response exceeds the limit.',
                canRetry: false,
              },
            },
          })
        }
      }
    }
    if (!isControlRequestBody(method, body)) {
      answer({
        status: 'error',
        error: {
          code: 'invalid-request',
          message: 'The request format is invalid.',
          canRetry: false,
        },
      })
      return
    }
    this.events.request(method, body).then(
      (value) => answer({ status: 'success', value }),
      (error: unknown) => answer({ status: 'error', error: toHttpError(error).operationError }),
    )
  }
}
