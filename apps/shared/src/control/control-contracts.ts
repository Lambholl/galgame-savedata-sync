import type {
  DirectoryListing,
  OperationError,
  OperationResult,
  TransferDirection,
} from '../protocol/contracts.ts'
import type { SyncPlan } from '../sync/sync-contracts.ts'
import type { SyncJobDigest, SyncJobState } from '../sync/sync-job-contracts.ts'

/** 控制通道的 WebSocket 路由。 */
export const CONTROL_ROUTE = '/v1/control'
/** 控制通道的消息大小、应答期限和心跳间隔。 */
export const CONTROL_LIMITS = {
  /** 单条消息上限，与 HTTP JSON 的大小上限一致。 */
  maxMessageBytes: 8388608,
  /** 请求等待应答的期限。 */
  requestTimeoutMs: 8000,
  /** 心跳间隔；一个间隔内没有回应时连接按断开处理。 */
  pingIntervalMs: 15000,
} as const

/** sync.prepare 的请求体：请执行方扫描指定游戏并生成计划。 */
export interface RemoteSyncPrepare {
  readonly requestId: string
  /** 执行方本机的游戏 ID。 */
  readonly projectId: string
  readonly direction: TransferDirection
}
/**
 * 扫描阶段的回报：preparing 表示已开始扫描，ready 附完整计划，failed 表示开始前失败。
 */
export type RemoteSyncReport =
  | { readonly requestId: string; readonly status: 'preparing' }
  | {
      readonly requestId: string
      readonly status: 'ready'
      readonly plan: SyncPlan
      /** 被写入一端的保留份数，随预览取得。 */
      readonly backupKeepCount: number
    }
  | { readonly requestId: string; readonly status: 'failed'; readonly error: OperationError }

/** 请求方法与请求体。 */
export interface ControlRequestBodies {
  /** 读取对方一层目录；rootId 必须属于对方已配置的游戏。 */
  readonly 'directory.list': { readonly rootId: string; readonly parentId: string | null }
  /** 请对方扫描并生成复制计划。 */
  readonly 'sync.prepare': RemoteSyncPrepare
  /** 确认对方回报的计划，对方开始执行；shouldDeleteExtras 表示是否删除只在目标的条目。 */
  readonly 'sync.confirm': { readonly requestId: string; readonly shouldDeleteExtras: boolean }
  /** 放弃还没开始执行的请求，对方取消并释放这次扫描。 */
  readonly 'sync.cancel': { readonly requestId: string }
  /** 读取对方角色的完整任务状态，含逐项结果；任务不存在时答复 not-found。 */
  readonly 'sync.job.read': { readonly jobId: string }
  /** 取消对方正在执行的任务；任务已结束时直接答复成功，任务不存在时答复 not-found。 */
  readonly 'sync.job.cancel': { readonly jobId: string }
}
/** 请求方法与成功应答值。 */
export interface ControlResponseValues {
  readonly 'directory.list': DirectoryListing
  readonly 'sync.prepare': null
  readonly 'sync.confirm': { readonly jobId: string }
  readonly 'sync.cancel': null
  readonly 'sync.job.read': SyncJobState
  readonly 'sync.job.cancel': null
}
/** 事件方法与事件体。 */
export interface ControlEventBodies {
  /** 发送方的游戏或关联已变化。 */
  readonly 'catalog.changed': Record<string, never>
  /** 执行方回报对方发起的扫描和计划。 */
  readonly 'sync.report': RemoteSyncReport
  /**
   * 执行方本机角色的任务摘要，覆盖两个发起端和两个方向。状态变化后 0.5 秒内发出，进行中
   * 至少每秒一次；连接恢复后补发最新一条。事件可能丢失，以最新一条为准。
   */
  readonly 'sync.job': SyncJobDigest
}
/** 控制请求的方法名。 */
export type ControlRequestMethod = keyof ControlRequestBodies
/** 控制事件的方法名。 */
export type ControlEventMethod = keyof ControlEventBodies

/** 控制请求；对方用同一个 id 应答。 */
export interface ControlRequest<M extends ControlRequestMethod = ControlRequestMethod> {
  readonly v: 1
  readonly type: 'request'
  readonly id: string
  readonly method: M
  readonly body: ControlRequestBodies[M]
}
/** 控制应答，id 与对应请求相同。 */
export interface ControlResponse {
  readonly v: 1
  readonly type: 'response'
  readonly id: string
  readonly result: OperationResult<unknown>
}
/** 控制事件，不需要应答。 */
export interface ControlEvent<M extends ControlEventMethod = ControlEventMethod> {
  readonly v: 1
  readonly type: 'event'
  readonly method: M
  readonly body: ControlEventBodies[M]
}
/** 控制通道上的一条消息。 */
export type ControlMessage = ControlRequest | ControlResponse | ControlEvent
