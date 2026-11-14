import {
  BATCH_LIMITS,
  isBackupKeepCount,
  isInterruptedWriteList,
  isOpaqueId,
  isOperationError,
  isOperationResult,
  isSyncApplyResult,
  isSyncFileWrite,
  isSyncJobRequest,
  isSyncPlan,
  isSyncTransferState,
  matchesSyncApplyResult,
  matchesSyncJobDigest,
  matchesSyncJobState,
  matchesSyncPlan,
  SYNC_STEP_DONE,
} from '@savedata-sync/shared'
import type {
  InterruptedWrite,
  OperationError,
  OperationResult,
  SyncApplyResult,
  SyncJobObservation,
  SyncJobRequest,
  SyncJobState,
  SyncPlan,
  SyncTransferState,
} from '@savedata-sync/shared'

/** 复制任务列表的一行；phase 到 percent 是由两个角色的状态合成的结论。 */
export interface DesktopCopySummary {
  readonly jobId: string
  readonly projectId: string
  readonly peerId: string
  readonly direction: SyncJobState['direction']
  readonly role: SyncJobState['role']
  readonly phase: SyncJobObservation['phase']
  readonly stage: SyncJobObservation['stage']
  readonly step: SyncJobObservation['step']
  readonly percent: SyncJobObservation['percent']
  readonly updatedAt: number
  readonly hasCleanupError: boolean
  /** 已经确认、移动端还没开始这次传输。 */
  readonly isAwaitingPeer: boolean
}
/** 本机恢复任务列表的一行。 */
export interface DesktopRestoreSummary {
  readonly restoreId: string
  readonly projectId: string
  readonly rootId: string
  readonly backupId: string
  readonly status:
    'preparing' | 'ready' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown'
  readonly stage:
    'preparing' | 'ready' | 'verifying' | 'backing-up' | 'writing' | 'cleaning' | 'done'
  readonly updatedAt: number
  readonly hasCleanupError: boolean
  readonly isWorking: boolean
}
/** 本机恢复任务的完整状态，包括进度、结果和错误。 */
export interface DesktopRestoreState extends DesktopRestoreSummary {
  readonly progress: {
    readonly publishedFiles: number
    readonly totalFiles: number
    readonly fileBytesPublished: number
    readonly totalFileBytes: number | null
  }
  readonly result: SyncApplyResult | null
  readonly error: OperationError | null
  readonly cleanupError: OperationError | null
}
/**
 * 电脑发起的复制请求：waiting 等移动端响应，preparing 表示移动端在扫描，ready 可以确认计划，
 * starting 等移动端开始执行，running 时 jobId 对应复制任务，succeeded 是移动端回报的成功结果；
 * failed 带失败原因，开始后的失败或取消也带 jobId。
 */
export interface DesktopRemoteRequest {
  readonly requestId: string
  readonly projectId: string
  readonly peerId: string
  readonly direction: SyncJobState['direction']
  readonly status:
    | 'waiting'
    | 'preparing'
    | 'ready'
    | 'starting'
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
  readonly jobId: string | null
  readonly error: OperationError | null
  /** 移动端回报的计划里，被写入一端的保留份数；还没回报时为 null。 */
  readonly backupKeepCount: number | null
  readonly updatedAt: number
}
/** 复制接口：查看和取消复制任务，本机恢复，以及向已连接的移动端发起复制。 */
export interface DesktopSyncApi {
  /** 判断服务是否有进行中的传输或复制任务。 */
  activity(): Promise<OperationResult<boolean>>
  /** 列出复制任务。 */
  copies(): Promise<OperationResult<readonly DesktopCopySummary[]>>
  /** 读取复制任务的登记请求，包括计划。 */
  copyPlan(jobId: string): Promise<OperationResult<SyncJobRequest>>
  /** 本机和对端两个角色的状态；对端结果还没确认时 remote 为进行中或 remoteError 非空。 */
  copyState(jobId: string): Promise<OperationResult<SyncTransferState>>
  /** 取消复制任务。 */
  cancelCopy(jobId: string): Promise<OperationResult<SyncTransferState>>
  /** 重试复制任务的缓存清理。 */
  cleanupCopy(jobId: string): Promise<OperationResult<null>>
  /** 列出本机恢复任务。 */
  restores(): Promise<OperationResult<readonly DesktopRestoreSummary[]>>
  /** 从一份备份创建恢复任务并生成恢复计划。 */
  prepareRestore(
    projectId: string,
    rootId: string,
    backupId: string,
  ): Promise<OperationResult<DesktopRestoreState>>
  /** 读取恢复计划。 */
  restorePlan(restoreId: string): Promise<OperationResult<SyncPlan>>
  /** 读取恢复任务的状态。 */
  restoreState(restoreId: string): Promise<OperationResult<DesktopRestoreState>>
  /** 按确认的计划执行恢复；plan 必须与 restorePlan 返回的计划相同。 */
  executeRestore(restoreId: string, plan: SyncPlan): Promise<OperationResult<DesktopRestoreState>>
  /** 取消恢复任务。 */
  cancelRestore(restoreId: string): Promise<OperationResult<DesktopRestoreState>>
  /** 重试恢复任务的缓存清理；任务还在运行时返回 busy。 */
  cleanupRestore(restoreId: string): Promise<OperationResult<DesktopRestoreState>>
  /** 释放已结束的恢复任务；任务还在运行时返回 busy。 */
  releaseRestore(restoreId: string): Promise<OperationResult<null>>
  /** 读取当前发起的请求；没有请求时为 null。 */
  remoteRequest(): Promise<OperationResult<DesktopRemoteRequest | null>>
  /** 请求已连接移动端扫描指定游戏；移动端应用版本不支持时返回 unsupported-operation。 */
  startRemote(
    projectId: string,
    peerId: string,
    direction: DesktopRemoteRequest['direction'],
  ): Promise<OperationResult<DesktopRemoteRequest>>
  /** 读取移动端回报的计划；请求还没到 ready 时返回错误。 */
  remotePlan(requestId: string): Promise<OperationResult<SyncPlan>>
  /** 确认计划并让移动端开始执行；计划按 shouldDeleteExtras 重新生成。 */
  confirmRemote(
    requestId: string,
    shouldDeleteExtras: boolean,
  ): Promise<OperationResult<DesktopRemoteRequest>>
  /** 取消发起的请求。 */
  cancelRemote(requestId: string): Promise<OperationResult<DesktopRemoteRequest>>
  /** 列出之前的进程没写完就结束时留下的写入标记。 */
  interruptedWrites(): Promise<OperationResult<readonly InterruptedWrite[]>>
  /** 删除一个写入标记。 */
  dismissInterruptedWrite(id: string): Promise<OperationResult<null>>
}
/** 复制接口的 IPC 通道名。 */
export const SYNC_CHANNELS = {
  activity: 'sync:activity',
  copies: 'sync:copies',
  copyPlan: 'sync:copy-plan',
  copyState: 'sync:copy-state',
  cancelCopy: 'sync:copy-cancel',
  cleanupCopy: 'sync:copy-cleanup',
  restores: 'sync:restores',
  prepareRestore: 'sync:restore-prepare',
  restorePlan: 'sync:restore-plan',
  restoreState: 'sync:restore-state',
  executeRestore: 'sync:restore-execute',
  cancelRestore: 'sync:restore-cancel',
  cleanupRestore: 'sync:restore-cleanup',
  releaseRestore: 'sync:restore-release',
  remoteRequest: 'sync:remote-request',
  startRemote: 'sync:remote-start',
  remotePlan: 'sync:remote-plan',
  confirmRemote: 'sync:remote-confirm',
  cancelRemote: 'sync:remote-cancel',
  interruptedWrites: 'sync:interrupted-writes',
  dismissInterruptedWrite: 'sync:interrupted-write-dismiss',
} as const

function shape(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((key) => Object.hasOwn(value, key))
  )
}
function member<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T)
}
function count(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum
}
function time(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= 8.64e15
}
const COPY_FIELDS = [
  'jobId',
  'projectId',
  'peerId',
  'direction',
  'role',
  'phase',
  'stage',
  'step',
  'percent',
  'updatedAt',
  'hasCleanupError',
  'isAwaitingPeer',
]
const RESTORE_FIELDS = [
  'restoreId',
  'projectId',
  'rootId',
  'backupId',
  'status',
  'stage',
  'updatedAt',
  'hasCleanupError',
  'isWorking',
]
const COPY_STAGES = [
  'preparing',
  'ready',
  'awaiting-content',
  'transferring',
  'backing-up',
  'writing',
  'cleaning',
  'done',
] as const

/** 校验复制任务摘要。 */
export function isDesktopCopySummary(value: unknown): value is DesktopCopySummary {
  return (
    shape(value, COPY_FIELDS) &&
    [value.jobId, value.projectId, value.peerId].every(isOpaqueId) &&
    member(value.direction, ['android-to-windows', 'windows-to-android']) &&
    value.role === (value.direction === 'android-to-windows' ? 'receiver' : 'sender') &&
    member(value.phase, ['running', 'done', 'partial', 'failed', 'cancelled', 'unknown']) &&
    member(value.stage, COPY_STAGES) &&
    (value.step === null || count(value.step, SYNC_STEP_DONE)) &&
    (value.percent === null || count(value.percent, 100)) &&
    time(value.updatedAt) &&
    typeof value.hasCleanupError === 'boolean' &&
    typeof value.isAwaitingPeer === 'boolean' &&
    (!value.isAwaitingPeer || value.phase === 'running') &&
    (value.phase === 'running' ? value.stage !== 'done' : value.stage === 'done')
  )
}
function restoreSummary(value: Record<string, unknown>): boolean {
  return (
    [value.restoreId, value.projectId, value.rootId, value.backupId].every(isOpaqueId) &&
    member(value.status, [
      'preparing',
      'ready',
      'running',
      'succeeded',
      'failed',
      'cancelled',
      'unknown',
    ]) &&
    member(value.stage, [
      'preparing',
      'ready',
      'verifying',
      'backing-up',
      'writing',
      'cleaning',
      'done',
    ]) &&
    time(value.updatedAt) &&
    typeof value.hasCleanupError === 'boolean' &&
    typeof value.isWorking === 'boolean' &&
    ((value.status !== 'preparing' && value.status !== 'running') || value.isWorking) &&
    (value.status !== 'ready' || !value.isWorking) &&
    (value.status === 'preparing' || value.status === 'ready'
      ? value.stage === value.status
      : value.status === 'running'
        ? !member(value.stage, ['preparing', 'ready', 'done'])
        : value.stage === 'done')
  )
}
/** 校验发起的复制请求。 */
export function isDesktopRemoteRequest(value: unknown): value is DesktopRemoteRequest {
  return (
    shape(value, [
      'requestId',
      'projectId',
      'peerId',
      'direction',
      'status',
      'jobId',
      'error',
      'backupKeepCount',
      'updatedAt',
    ]) &&
    (value.backupKeepCount === null || isBackupKeepCount(value.backupKeepCount)) &&
    [value.requestId, value.projectId, value.peerId].every(isOpaqueId) &&
    member(value.direction, ['android-to-windows', 'windows-to-android']) &&
    member(value.status, [
      'waiting',
      'preparing',
      'ready',
      'starting',
      'running',
      'succeeded',
      'failed',
      'cancelled',
    ]) &&
    // 已开始的任务带 jobId；失败或取消可能发生在开始前，也可能在开始后。
    (value.status === 'running' || value.status === 'succeeded'
      ? isOpaqueId(value.jobId)
      : value.status === 'failed' || value.status === 'cancelled'
        ? value.jobId === null || isOpaqueId(value.jobId)
        : value.jobId === null) &&
    (value.status === 'failed' ? isOperationError(value.error) : value.error === null) &&
    time(value.updatedAt)
  )
}
/** 校验恢复任务摘要。 */
export function isDesktopRestoreSummary(value: unknown): value is DesktopRestoreSummary {
  return shape(value, RESTORE_FIELDS) && restoreSummary(value)
}
/** 校验恢复任务的完整状态。 */
export function isDesktopRestoreState(value: unknown): value is DesktopRestoreState {
  if (
    !shape(value, [...RESTORE_FIELDS, 'progress', 'result', 'error', 'cleanupError']) ||
    !restoreSummary(value) ||
    !(value.error === null || isOperationError(value.error)) ||
    !(
      value.cleanupError === null ||
      (isOperationError(value.cleanupError) && value.cleanupError.code === 'cleanup-failed')
    ) ||
    value.hasCleanupError !== (value.cleanupError !== null) ||
    !(value.result === null || isSyncApplyResult(value.result))
  ) {
    return false
  }
  const progress = value.progress
  if (
    !shape(progress, ['publishedFiles', 'totalFiles', 'fileBytesPublished', 'totalFileBytes']) ||
    !count(progress.totalFiles, BATCH_LIMITS.maxFiles) ||
    !count(progress.publishedFiles, progress.totalFiles) ||
    !(
      progress.totalFileBytes === null ||
      count(progress.totalFileBytes, BATCH_LIMITS.maxTotalFileBytes)
    ) ||
    !count(progress.fileBytesPublished, progress.totalFileBytes ?? 0)
  ) {
    return false
  }
  if (member(value.status, ['preparing', 'ready', 'running'])) {
    return value.error === null && value.result === null
  }
  if (value.status === 'unknown' && value.error?.code !== 'result-unknown') {
    return false
  }
  if (value.status !== 'unknown' && value.error?.code === 'result-unknown') {
    return false
  }
  if (
    (value.status === 'failed' && value.error === null) ||
    (value.status === 'cancelled' && value.error !== null)
  ) {
    return false
  }
  if (value.result === null) {
    return (
      value.status !== 'succeeded' &&
      value.status !== 'unknown' &&
      progress.publishedFiles === 0 &&
      progress.fileBytesPublished === 0
    )
  }
  const files = value.result.outcomes.filter(
    (item) => item.status === 'succeeded' && isSyncFileWrite(item.action),
  )
  return (
    files.length === progress.publishedFiles &&
    files.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0) === progress.fileBytesPublished &&
    JSON.stringify(value.error) === JSON.stringify(value.result.error) &&
    JSON.stringify(value.cleanupError) === JSON.stringify(value.result.cleanupError) &&
    (value.status !== 'succeeded' ||
      (value.error === null && value.result.outcomes.every((item) => item.status === 'succeeded')))
  )
}

/**
 * 用 invoke 创建冻结的 DesktopSyncApi。
 *
 * @returns 参数无效、返回格式不对或计划不属于同一次任务时，对应方法返回错误结果。
 */
export function createSyncBridge(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
): DesktopSyncApi {
  const plans = new Map<string, SyncJobRequest>(),
    restores = new Map<string, SyncPlan>()
  function failure(): OperationResult<never> {
    return {
      status: 'error',
      error: {
        code: 'invalid-request',
        message: '同步参数或响应无效，请重新读取。',
        canRetry: false,
      },
    }
  }
  function remember<T>(cache: Map<string, T>, id: string, value: T): void {
    if (!cache.has(id) && cache.size >= 32) {
      const first = cache.keys().next().value
      if (first !== undefined) {
        cache.delete(first)
      }
    }
    cache.set(id, structuredClone(value))
  }
  async function call<T>(
    action: keyof typeof SYNC_CHANNELS,
    args: readonly unknown[],
    guard: (value: unknown) => value is T,
  ): Promise<OperationResult<T>> {
    try {
      const result = await invoke(SYNC_CHANNELS[action], ...args)
      return isOperationResult(result, guard) ? result : failure()
    } catch {
      return failure()
    }
  }
  async function copyPlan(jobId: string): Promise<OperationResult<SyncJobRequest>> {
    if (!isOpaqueId(jobId)) {
      return failure()
    }
    const result = await call(
      'copyPlan',
      [{ jobId }],
      (value): value is SyncJobRequest => isSyncJobRequest(value) && value.jobId === jobId,
    )
    if (result.status === 'success') {
      remember(plans, jobId, result.value)
    }
    return result
  }
  async function copyState(
    action: 'copyState' | 'cancelCopy',
    jobId: string,
  ): Promise<OperationResult<SyncTransferState>> {
    if (!isOpaqueId(jobId)) {
      return failure()
    }
    const result = await call(
      action,
      [{ jobId }],
      (value): value is SyncTransferState => isSyncTransferState(value) && value.jobId === jobId,
    )
    if (result.status === 'error') {
      return result
    }
    const { local, remote } = result.value
    const cached = plans.get(jobId)
    const context = cached ? { status: 'success' as const, value: cached } : await copyPlan(jobId)
    if (context.status === 'error') {
      return context
    }
    const request = context.value
    // 对端的状态已在主进程核对过，这里只核对它属于本次任务。
    return local.role ===
      (request.plan.direction === 'android-to-windows' ? 'receiver' : 'sender') &&
      matchesSyncJobState(local, request) &&
      (remote === null ||
        (matchesSyncJobDigest(remote, request, local.role) &&
          (remote.result === null || matchesSyncApplyResult(remote.result, request.plan))))
      ? result
      : failure()
  }
  async function restorePlan(restoreId: string): Promise<OperationResult<SyncPlan>> {
    if (!isOpaqueId(restoreId)) {
      return failure()
    }
    const result = await call(
      'restorePlan',
      [{ restoreId }],
      (value): value is SyncPlan =>
        isSyncPlan(value) &&
        value.operation === 'restore' &&
        value.direction === 'local-restore' &&
        value.shouldBackup,
    )
    if (result.status === 'success') {
      remember(restores, restoreId, result.value)
    }
    return result
  }
  async function restoreState(
    action: 'restoreState' | 'cancelRestore' | 'cleanupRestore' | 'executeRestore',
    restoreId: string,
    plan?: SyncPlan,
  ): Promise<OperationResult<DesktopRestoreState>> {
    if (
      !isOpaqueId(restoreId) ||
      (action === 'executeRestore' &&
        (!isSyncPlan(plan) ||
          !plan.canExecute ||
          plan.operation !== 'restore' ||
          plan.direction !== 'local-restore' ||
          !plan.shouldBackup))
    ) {
      return failure()
    }
    if (plan) {
      const cached = restores.get(restoreId)
      const context = cached
        ? { status: 'success' as const, value: cached }
        : await restorePlan(restoreId)
      if (context.status === 'error') {
        return context
      }
      const expected = context.value
      if (
        !matchesSyncPlan(plan, {
          planId: expected.planId,
          projectId: expected.projectId,
          operation: expected.operation,
          direction: expected.direction,
          shouldBackup: expected.shouldBackup,
          shouldDeleteExtras: expected.shouldDeleteExtras,
          source: expected.source,
          target: expected.target,
        })
      ) {
        return failure()
      }
    }
    const result = await call(
      action,
      [plan ? { restoreId, plan } : { restoreId }],
      (value): value is DesktopRestoreState =>
        isDesktopRestoreState(value) && value.restoreId === restoreId,
    )
    if (result.status === 'success' && result.value.result !== null) {
      const cached = restores.get(restoreId)
      const context = cached
        ? { status: 'success' as const, value: cached }
        : await restorePlan(restoreId)
      if (context.status === 'error') {
        return context
      }
      const expected = context.value
      if (
        result.value.projectId !== expected.projectId ||
        result.value.rootId !== expected.target.rootId ||
        !matchesSyncApplyResult(result.value.result, expected)
      ) {
        return failure()
      }
    }
    return result
  }
  function remoteAction(
    action: 'confirmRemote' | 'cancelRemote',
    requestId: string,
    shouldDeleteExtras?: boolean,
  ): Promise<OperationResult<DesktopRemoteRequest>> {
    return isOpaqueId(requestId)
      ? call(
          action,
          [action === 'confirmRemote' ? { requestId, shouldDeleteExtras } : { requestId }],
          (value): value is DesktopRemoteRequest =>
            isDesktopRemoteRequest(value) && value.requestId === requestId,
        )
      : Promise.resolve(failure())
  }
  return Object.freeze({
    activity: () => call('activity', [], (value): value is boolean => typeof value === 'boolean'),
    copies: () =>
      call(
        'copies',
        [],
        (value): value is readonly DesktopCopySummary[] =>
          Array.isArray(value) &&
          // 32 个已登记任务，加一个已确认、移动端还没登记的任务。
          value.length <= 33 &&
          value.every(isDesktopCopySummary) &&
          new Set(value.map((item) => item.jobId)).size === value.length,
      ),
    copyPlan,
    copyState: (jobId: string) => copyState('copyState', jobId),
    cancelCopy: (jobId: string) => copyState('cancelCopy', jobId),
    cleanupCopy: (jobId: string) =>
      isOpaqueId(jobId)
        ? call('cleanupCopy', [{ jobId }], (value): value is null => value === null)
        : Promise.resolve(failure()),
    restores: () =>
      call(
        'restores',
        [],
        (value): value is readonly DesktopRestoreSummary[] =>
          Array.isArray(value) &&
          value.length <= 32 &&
          value.every(isDesktopRestoreSummary) &&
          new Set(value.map((item) => item.restoreId)).size === value.length,
      ),
    prepareRestore: (projectId: string, rootId: string, backupId: string) =>
      [projectId, rootId, backupId].every(isOpaqueId)
        ? call(
            'prepareRestore',
            [{ projectId, rootId, backupId }],
            (value): value is DesktopRestoreState =>
              isDesktopRestoreState(value) &&
              value.projectId === projectId &&
              value.rootId === rootId &&
              value.backupId === backupId,
          )
        : Promise.resolve(failure()),
    restorePlan,
    restoreState: (restoreId: string) => restoreState('restoreState', restoreId),
    executeRestore: (restoreId: string, plan: SyncPlan) =>
      restoreState('executeRestore', restoreId, plan),
    cancelRestore: (restoreId: string) => restoreState('cancelRestore', restoreId),
    cleanupRestore: (restoreId: string) => restoreState('cleanupRestore', restoreId),
    async releaseRestore(restoreId: string) {
      if (!isOpaqueId(restoreId)) {
        return failure()
      }
      const result = await call(
        'releaseRestore',
        [{ restoreId }],
        (value): value is null => value === null,
      )
      if (result.status === 'success') {
        restores.delete(restoreId)
      }
      return result
    },
    remoteRequest: () =>
      call(
        'remoteRequest',
        [],
        (value): value is DesktopRemoteRequest | null =>
          value === null || isDesktopRemoteRequest(value),
      ),
    startRemote: (
      projectId: string,
      peerId: string,
      direction: DesktopRemoteRequest['direction'],
    ) =>
      [projectId, peerId].every(isOpaqueId) &&
      member(direction, ['android-to-windows', 'windows-to-android'])
        ? call(
            'startRemote',
            [{ projectId, peerId, direction }],
            (value): value is DesktopRemoteRequest =>
              isDesktopRemoteRequest(value) &&
              value.projectId === projectId &&
              value.peerId === peerId &&
              value.direction === direction,
          )
        : Promise.resolve(failure()),
    remotePlan: (requestId: string) =>
      isOpaqueId(requestId)
        ? call(
            'remotePlan',
            [{ requestId }],
            (value): value is SyncPlan => isSyncPlan(value) && value.operation === 'copy',
          )
        : Promise.resolve(failure()),
    confirmRemote: (requestId: string, shouldDeleteExtras: boolean) =>
      typeof shouldDeleteExtras === 'boolean'
        ? remoteAction('confirmRemote', requestId, shouldDeleteExtras)
        : Promise.resolve(failure()),
    cancelRemote: (requestId: string) => remoteAction('cancelRemote', requestId),
    interruptedWrites: () => call('interruptedWrites', [], isInterruptedWriteList),
    dismissInterruptedWrite: (id: string) =>
      isOpaqueId(id)
        ? call('dismissInterruptedWrite', [{ id }], (value): value is null => value === null)
        : Promise.resolve(failure()),
  })
}
