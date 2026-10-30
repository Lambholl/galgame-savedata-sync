import type {
  DirectoryListing,
  OperationError,
  OperationResult,
  TransferDirection,
} from '../protocol/contracts.ts'
import type { SyncPlan } from '../sync/sync-contracts.ts'

/**
 * 设备间控制通道：拨号方交换目录表后连上监听方的 WebSocket，之后双方对等收发请求、应答和事件。
 * 只传控制消息；文件内容和复制任务数据仍走 HTTP 路由。两端须使用同一协议版本。
 */
export const CONTROL_ROUTE = '/v1/control'
export const CONTROL_LIMITS = {
  /** 单条消息上限，与 HTTP JSON 预算一致。 */
  maxMessageBytes: 8388608,
  /** 请求等待应答的期限。 */
  requestTimeoutMs: 8000,
  /** 心跳间隔；一个间隔内没有回应即视为断开。 */
  pingIntervalMs: 15000,
} as const

export interface RemoteSyncPrepare {
  readonly requestId: string
  /** 执行方本机的游戏 ID。 */
  readonly projectId: string
  readonly direction: TransferDirection
}
/**
 * 执行方的回报：preparing 已开始扫描，ready 附完整计划，failed 表示开始前失败；
 * finished 是已开始任务的最终结果，outcome 为 failed/unknown 时可附原因。
 */
export type RemoteSyncReport =
  | { readonly requestId: string; readonly status: 'preparing' }
  | { readonly requestId: string; readonly status: 'ready'; readonly plan: SyncPlan }
  | { readonly requestId: string; readonly status: 'failed'; readonly error: OperationError }
  | {
      readonly requestId: string
      readonly status: 'finished'
      readonly jobId: string
      readonly outcome: 'succeeded' | 'failed' | 'cancelled' | 'unknown'
      readonly error: OperationError | null
    }

/** 请求方法与请求体。 */
export interface ControlRequestBodies {
  /** 读取对方一层目录；rootId 必须属于对方已配置的游戏。 */
  readonly 'directory.list': { readonly rootId: string; readonly parentId: string | null }
  /** 请对方扫描并生成复制计划。 */
  readonly 'sync.prepare': RemoteSyncPrepare
  /** 确认对方回报的计划，由对方开始执行。 */
  readonly 'sync.confirm': { readonly requestId: string }
  /** 放弃尚未开始的请求；对方取消并释放本次扫描。 */
  readonly 'sync.cancel': { readonly requestId: string }
}
/** 请求方法与成功应答值。 */
export interface ControlResponseValues {
  readonly 'directory.list': DirectoryListing
  readonly 'sync.prepare': null
  readonly 'sync.confirm': { readonly jobId: string }
  readonly 'sync.cancel': null
}
/** 事件方法与事件体。 */
export interface ControlEventBodies {
  /** 发送方的游戏或关联已变化；拨号方收到后重新交换目录表。 */
  readonly 'catalog.changed': Record<string, never>
  /** 执行方回报对方发起的复制进度。 */
  readonly 'sync.report': RemoteSyncReport
}
export type ControlRequestMethod = keyof ControlRequestBodies
export type ControlEventMethod = keyof ControlEventBodies

export interface ControlRequest<M extends ControlRequestMethod = ControlRequestMethod> {
  readonly v: 1
  readonly type: 'request'
  readonly id: string
  readonly method: M
  readonly body: ControlRequestBodies[M]
}
export interface ControlResponse {
  readonly v: 1
  readonly type: 'response'
  readonly id: string
  readonly result: OperationResult<unknown>
}
export interface ControlEvent<M extends ControlEventMethod = ControlEventMethod> {
  readonly v: 1
  readonly type: 'event'
  readonly method: M
  readonly body: ControlEventBodies[M]
}
export type ControlMessage = ControlRequest | ControlResponse | ControlEvent
