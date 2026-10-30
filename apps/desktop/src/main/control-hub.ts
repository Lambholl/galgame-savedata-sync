import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import type { RawData, WebSocket } from 'ws'
import {
  CONTROL_LIMITS,
  isControlEventBody,
  isControlMessage,
  isControlRequestBody,
  isControlResponseValue,
} from '@savedata-sync/shared'
import type {
  ControlEventBodies,
  ControlEventMethod,
  ControlMessage,
  ControlRequestBodies,
  ControlRequestMethod,
  ControlResponseValues,
} from '@savedata-sync/shared'
import { HttpOperationError, toHttpError } from './http-errors.ts'
import { inspectJsonKeys } from './http-wire.ts'

/** 本机主动断开设备时的关闭码；拨号方收到后不再重连。 */
export const CONTROL_CLOSE_DISCONNECTED = 4001
/** 同一设备的新连接取代旧连接。 */
const CONTROL_CLOSE_REPLACED = 4002

interface Pending {
  readonly method: ControlRequestMethod
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}
interface Peer {
  readonly socket: WebSocket
  readonly pending: Map<string, Pending>
  isAlive: boolean
}
export interface ControlListener {
  readonly event?: <M extends ControlEventMethod>(
    peerId: string,
    method: M,
    body: ControlEventBodies[M],
  ) => void
  readonly closed?: (peerId: string) => void
}

/**
 * 控制通道的监听端：身份由 HTTP 服务在升级前核实，这里只管消息收发、应答期限和心跳。
 * 收到的消息按共享格式严格校验，格式错误即关闭连接；对方发来的请求目前一律答复不支持。
 */
export class ControlHub {
  private readonly server = new WebSocketServer({
    noServer: true,
    maxPayload: CONTROL_LIMITS.maxMessageBytes,
    perMessageDeflate: false,
    clientTracking: false,
  })
  private readonly peers = new Map<string, Peer>()
  private readonly listeners = new Set<ControlListener>()
  private readonly heartbeat = setInterval(() => this.ping(), CONTROL_LIMITS.pingIntervalMs)

  constructor() {
    this.heartbeat.unref()
  }

  subscribe(listener: ControlListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 接管已核实身份的升级请求。 */
  accept(request: IncomingMessage, socket: Duplex, head: Buffer, peerId: string): void {
    this.server.handleUpgrade(request, socket, head, (ws) => this.attach(peerId, ws))
  }

  isOpen(peerId: string): boolean {
    return this.peers.has(peerId)
  }

  /** 向对方发请求；连接断开、超时或对方答复错误时以 HttpOperationError 拒绝。 */
  request<M extends ControlRequestMethod>(
    peerId: string,
    method: M,
    body: ControlRequestBodies[M],
  ): Promise<ControlResponseValues[M]> {
    const peer = this.peers.get(peerId)
    if (!peer) {
      return Promise.reject(new HttpOperationError('network-failure', '设备未连接。'))
    }
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        peer.pending.delete(id)
        reject(new HttpOperationError('timeout', '对方没有响应，请确认应用仍然打开。'))
      }, CONTROL_LIMITS.requestTimeoutMs)
      peer.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      })
      try {
        this.send(peer, { v: 1, type: 'request', id, method, body })
      } catch (error) {
        clearTimeout(timer)
        peer.pending.delete(id)
        reject(toHttpError(error))
      }
    })
  }

  /** 通知对方；未连接时忽略，事件不保证送达。 */
  emit<M extends ControlEventMethod>(peerId: string, method: M, body: ControlEventBodies[M]): void {
    const peer = this.peers.get(peerId)
    if (peer) {
      this.send(peer, { v: 1, type: 'event', method, body })
    }
  }

  /** 发给所有已连接设备。 */
  broadcast<M extends ControlEventMethod>(method: M, body: ControlEventBodies[M]): void {
    for (const peerId of this.peers.keys()) {
      this.emit(peerId, method, body)
    }
  }

  /** 本机断开设备；拨号方收到关闭码后不再重连。 */
  disconnect(peerId: string): void {
    this.peers.get(peerId)?.socket.close(CONTROL_CLOSE_DISCONNECTED, 'disconnected')
  }

  stop(): void {
    clearInterval(this.heartbeat)
    for (const peer of this.peers.values()) {
      peer.socket.terminate()
    }
    this.server.close()
  }

  private attach(peerId: string, socket: WebSocket): void {
    this.peers.get(peerId)?.socket.close(CONTROL_CLOSE_REPLACED, 'replaced')
    const peer: Peer = { socket, pending: new Map(), isAlive: true }
    this.peers.set(peerId, peer)
    socket.on('pong', () => {
      peer.isAlive = true
    })
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        socket.close(1003, 'text-only')
      } else {
        this.receive(peerId, peer, data)
      }
    })
    socket.on('error', () => socket.terminate())
    socket.on('close', () => {
      for (const pending of peer.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(new HttpOperationError('network-failure', '设备已断开。'))
      }
      peer.pending.clear()
      if (this.peers.get(peerId) === peer) {
        this.peers.delete(peerId)
        for (const listener of this.listeners) {
          listener.closed?.(peerId)
        }
      }
    })
  }

  private receive(peerId: string, peer: Peer, data: RawData): void {
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
      peer.socket.close(1007, 'invalid-json')
      return
    }
    if (!isControlMessage(message)) {
      peer.socket.close(1008, 'invalid-message')
      return
    }
    if (message.type === 'response') {
      const pending = peer.pending.get(message.id)
      if (!pending) {
        return
      }
      peer.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.result.status === 'error') {
        pending.reject(
          new HttpOperationError(message.result.error.code, message.result.error.message),
        )
      } else if (isControlResponseValue(pending.method, message.result.value)) {
        pending.resolve(message.result.value)
      } else {
        pending.reject(new HttpOperationError('invalid-request', '对方的应答格式无效。'))
      }
      return
    }
    if (message.type === 'request') {
      const isValid = isControlRequestBody(message.method, message.body)
      this.send(peer, {
        v: 1,
        type: 'response',
        id: message.id,
        result: {
          status: 'error',
          error: isValid
            ? { code: 'unsupported-operation', message: '电脑不处理这个请求。', canRetry: false }
            : { code: 'invalid-request', message: '请求格式无效。', canRetry: false },
        },
      })
      return
    }
    if (!isControlEventBody(message.method, message.body)) {
      peer.socket.close(1008, 'invalid-event')
      return
    }
    for (const listener of this.listeners) {
      listener.event?.(peerId, message.method, message.body)
    }
  }

  private send(peer: Peer, message: ControlMessage): void {
    const text = JSON.stringify(message)
    if (Buffer.byteLength(text) > CONTROL_LIMITS.maxMessageBytes) {
      throw new HttpOperationError('resource-limit', '控制消息超过限制。')
    }
    peer.socket.send(text)
  }

  /** 一个间隔内没有回应的连接直接终止，由 close 事件通知断开。 */
  private ping(): void {
    for (const peer of this.peers.values()) {
      if (!peer.isAlive) {
        peer.socket.terminate()
        continue
      }
      peer.isAlive = false
      peer.socket.ping()
    }
  }
}
