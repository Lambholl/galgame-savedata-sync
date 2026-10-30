import {
  BATCH_LIMITS,
  isOpaqueId,
  isOperationError,
  isOperationResult,
  isSyncApplyResult,
  isSyncJobRequest,
  isSyncJobState,
  isSyncPlan,
  matchesSyncApplyResult,
  matchesSyncJobManifest,
  matchesSyncJobState,
  matchesSyncPlan,
} from '@savedata-sync/shared'
import type {
  BatchManifest,
  OperationError,
  OperationResult,
  SyncApplyResult,
  SyncJobRequest,
  SyncJobState,
  SyncPlan,
} from '@savedata-sync/shared'

/** 列表仅含有界摘要；计划、清单及逐项结果分别读取，避免轮询合并大响应。 */
export interface DesktopCopySummary {
  readonly jobId: string
  readonly projectId: string
  readonly peerId: string
  readonly direction: SyncJobState['direction']
  readonly role: SyncJobState['role']
  readonly status: SyncJobState['status']
  readonly stage: SyncJobState['stage']
  readonly updatedAt: number
  readonly hasCleanupError: boolean
}
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
 * 电脑发起的复制请求：waiting 等手机响应，preparing 手机在扫描，ready 可确认计划，
 * starting 等手机开始执行，running 时 jobId 对应复制任务，succeeded 是手机回报的成功结果；
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
  readonly updatedAt: number
}
/** 本机查看/取消既有复制及手工恢复，并向已连接手机发起复制；不提供路径、文件字节或通用 IPC。 */
export interface DesktopSyncApi {
  activity(): Promise<OperationResult<boolean>>
  copies(): Promise<OperationResult<readonly DesktopCopySummary[]>>
  copyPlan(jobId: string): Promise<OperationResult<SyncJobRequest>>
  copyState(jobId: string): Promise<OperationResult<SyncJobState>>
  cancelCopy(jobId: string): Promise<OperationResult<SyncJobState>>
  cleanupCopy(jobId: string): Promise<OperationResult<null>>
  restores(): Promise<OperationResult<readonly DesktopRestoreSummary[]>>
  prepareRestore(
    projectId: string,
    rootId: string,
    backupId: string,
  ): Promise<OperationResult<DesktopRestoreState>>
  restorePlan(restoreId: string): Promise<OperationResult<SyncPlan>>
  restoreState(restoreId: string): Promise<OperationResult<DesktopRestoreState>>
  executeRestore(restoreId: string, plan: SyncPlan): Promise<OperationResult<DesktopRestoreState>>
  cancelRestore(restoreId: string): Promise<OperationResult<DesktopRestoreState>>
  cleanupRestore(restoreId: string): Promise<OperationResult<DesktopRestoreState>>
  releaseRestore(restoreId: string): Promise<OperationResult<null>>
  /** 当前发起请求；没有请求时返回 null。 */
  remoteRequest(): Promise<OperationResult<DesktopRemoteRequest | null>>
  /** 请求已连接手机扫描指定游戏；手机未运行新版应用时返回 unsupported-operation。 */
  startRemote(
    projectId: string,
    peerId: string,
    direction: DesktopRemoteRequest['direction'],
  ): Promise<OperationResult<DesktopRemoteRequest>>
  /** 读取手机回报的计划，只在 ready 及之后可用。 */
  remotePlan(requestId: string): Promise<OperationResult<SyncPlan>>
  confirmRemote(requestId: string): Promise<OperationResult<DesktopRemoteRequest>>
  cancelRemote(requestId: string): Promise<OperationResult<DesktopRemoteRequest>>
}
export const SYNC_CHANNELS = {
  activity: 'sync:activity',
  copies: 'sync:copies',
  copyPlan: 'sync:copy-plan',
  copyState: 'sync:copy-state',
  copyManifest: 'sync:copy-manifest',
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
  'status',
  'stage',
  'updatedAt',
  'hasCleanupError',
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
  'verifying',
  'backing-up',
  'writing',
  'cleaning',
  'done',
] as const

export function isDesktopCopySummary(value: unknown): value is DesktopCopySummary {
  return (
    shape(value, COPY_FIELDS) &&
    [value.jobId, value.projectId, value.peerId].every(isOpaqueId) &&
    member(value.direction, ['android-to-windows', 'windows-to-android']) &&
    value.role === (value.direction === 'android-to-windows' ? 'receiver' : 'sender') &&
    member(value.status, ['running', 'sent', 'succeeded', 'failed', 'cancelled', 'unknown']) &&
    member(value.stage, COPY_STAGES) &&
    time(value.updatedAt) &&
    typeof value.hasCleanupError === 'boolean' &&
    (value.status === 'running' ? value.stage !== 'done' : value.stage === 'done') &&
    (value.status !== 'sent' || value.role === 'sender') &&
    (value.status !== 'succeeded' || value.role === 'receiver')
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
      'updatedAt',
    ]) &&
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
export function isDesktopRestoreSummary(value: unknown): value is DesktopRestoreSummary {
  return shape(value, RESTORE_FIELDS) && restoreSummary(value)
}
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
    (item) => item.status === 'succeeded' && item.action !== 'create-directory',
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

/** preload 校验参数、有限响应及同次计划；有界缓存可从主进程恢复，不保存文件数据。 */
export function createSyncBridge(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
): DesktopSyncApi {
  const plans = new Map<string, SyncJobRequest>(),
    restores = new Map<string, SyncPlan>(),
    manifests = new Map<string, BatchManifest>()
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
        if (cache === plans) {
          manifests.delete(first)
        }
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
  ): Promise<OperationResult<SyncJobState>> {
    if (!isOpaqueId(jobId)) {
      return failure()
    }
    const result = await call(action, [{ jobId }], isSyncJobState)
    if (result.status === 'error') {
      return result
    }
    const cached = plans.get(jobId)
    const context = cached ? { status: 'success' as const, value: cached } : await copyPlan(jobId)
    if (context.status === 'error') {
      return context
    }
    const request = context.value
    let manifest = manifests.get(jobId) ?? null
    if (
      request.plan.transferFileCount > 0 &&
      result.value.progress.totalArchiveBytes !== null &&
      !manifest
    ) {
      const declaration = await call(
        'copyManifest',
        [{ jobId }],
        (value): value is BatchManifest => value !== null && matchesSyncJobManifest(value, request),
      )
      if (declaration.status === 'error') {
        return declaration
      }
      manifest = declaration.value
      remember(manifests, jobId, manifest)
    }
    return result.value.role ===
      (request.plan.direction === 'android-to-windows' ? 'receiver' : 'sender') &&
      matchesSyncJobState(
        result.value,
        request,
        result.value.progress.totalArchiveBytes === null ? null : manifest,
      )
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
  ): Promise<OperationResult<DesktopRemoteRequest>> {
    return isOpaqueId(requestId)
      ? call(
          action,
          [{ requestId }],
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
          value.length <= 32 &&
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
    confirmRemote: (requestId: string) => remoteAction('confirmRemote', requestId),
    cancelRemote: (requestId: string) => remoteAction('cancelRemote', requestId),
  })
}
