import {
  BATCH_LIMITS,
  createSyncPlan,
  isOpaqueId,
  isOperationError,
  isInterruptedWriteList,
  isOperationResult,
  isSyncApplyResult,
  isSyncFileWrite,
  isSyncPlan,
  isSyncSnapshot,
  matchesSyncApplyResult,
} from '@savedata-sync/shared'
import type {
  InterruptedWrite,
  OperationError,
  OperationResult,
  SyncApplyResult,
  SyncPlan,
  SyncRestoreFailureStage,
  SyncRestoreProgress,
  SyncRestoreStage,
  SyncRestoreStatus,
} from '@savedata-sync/shared'

/** 本机恢复任务的状态；恢复计划用 preview 单独读取。 */
export interface AndroidRestoreState {
  readonly restoreId: string
  readonly projectId: string
  readonly rootId: string
  readonly backupId: string
  readonly status: SyncRestoreStatus
  readonly stage: SyncRestoreStage
  readonly failureStage: SyncRestoreFailureStage | null
  readonly updatedAt: number
  readonly progress: SyncRestoreProgress
  readonly result: SyncApplyResult | null
  readonly error: OperationError | null
}
/** 本机写入和恢复的原生插件；方法与 AndroidSyncWriteApi 的同名方法对应，返回值未经校验。 */
export interface SyncWriteNativePlugin {
  bindProject(options: { projectId: string; rootId: string }): Promise<unknown>
  prepareRestore(options: { projectId: string; rootId: string; backupId: string }): Promise<unknown>
  query(options: { restoreId: string }): Promise<unknown>
  current(): Promise<unknown>
  preview(options: { restoreId: string }): Promise<unknown>
  execute(options: { restoreId: string; plan: SyncPlan }): Promise<unknown>
  cancel(options: { restoreId: string }): Promise<unknown>
  release(options: { restoreId: string }): Promise<unknown>
  retryCleanup(): Promise<unknown>
  interrupted(): Promise<unknown>
  dismissInterrupted(options: { id: string }): Promise<unknown>
}
/** 本机恢复接口。所有方法的失败都以错误结果返回。 */
export interface AndroidSyncWriteApi {
  /** 把本机项目绑定到一个已登记的根目录；有任务进行中时返回 busy。 */
  bindProject(projectId: string, rootId: string): Promise<OperationResult<null>>
  /** 从一份备份创建恢复任务并生成恢复计划。 */
  prepareRestore(
    projectId: string,
    rootId: string,
    backupId: string,
  ): Promise<OperationResult<AndroidRestoreState>>
  /** 读取恢复任务的状态。 */
  query(restoreId: string): Promise<OperationResult<AndroidRestoreState>>
  /** 读取当前恢复任务的 ID；没有时为 null。 */
  current(): Promise<OperationResult<string | null>>
  /** 读取恢复计划。 */
  preview(restoreId: string): Promise<OperationResult<SyncPlan>>
  /** 按确认的计划执行恢复；plan 必须与 preview 返回的计划相同。 */
  execute(restoreId: string, plan: SyncPlan): Promise<OperationResult<AndroidRestoreState>>
  /** 取消恢复任务。 */
  cancel(restoreId: string): Promise<OperationResult<AndroidRestoreState>>
  /** 释放已结束或还没开始的恢复任务。 */
  release(restoreId: string): Promise<OperationResult<null>>
  /** 重试恢复任务的清理；还有资源没释放时返回 cleanup-failed。 */
  retryCleanup(): Promise<OperationResult<null>>
  /** 列出之前的进程没写完就结束时留下的写入标记。 */
  interruptedWrites(): Promise<OperationResult<readonly InterruptedWrite[]>>
  /** 删除一个写入标记。 */
  dismissInterruptedWrite(id: string): Promise<OperationResult<null>>
}
function shape(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  )
}
function invalid(
  code: 'invalid-request' | 'internal-error' | 'unsupported-operation',
): OperationResult<never> {
  return {
    status: 'error',
    error: {
      code,
      message:
        code === 'unsupported-operation'
          ? 'Restore local backups in the Android app.'
          : 'Local restore parameters or the response are invalid.',
      canRetry: false,
    },
  }
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
function isState(value: unknown): value is AndroidRestoreState {
  if (
    !shape(value, [
      'restoreId',
      'projectId',
      'rootId',
      'backupId',
      'status',
      'stage',
      'failureStage',
      'updatedAt',
      'progress',
      'result',
      'error',
    ]) ||
    ![value.restoreId, value.projectId, value.rootId, value.backupId].every(isOpaqueId) ||
    !member(value.status, [
      'preparing',
      'ready',
      'running',
      'succeeded',
      'failed',
      'cancelled',
      'unknown',
    ]) ||
    !member(value.stage, [
      'preparing',
      'ready',
      'verifying',
      'backing-up',
      'writing',
      'cleaning',
      'done',
    ]) ||
    !(
      value.failureStage === null ||
      member(value.failureStage, ['preparing', 'backing-up', 'writing'])
    ) ||
    !time(value.updatedAt) ||
    !(value.error === null || isOperationError(value.error)) ||
    !(value.result === null || isSyncApplyResult(value.result))
  ) {
    return false
  }
  const progress = value.progress
  if (
    !shape(progress, [
      'backupBytesCopied',
      'totalBackupBytes',
      'publishedFiles',
      'totalFiles',
      'fileBytesPublished',
      'totalFileBytes',
    ]) ||
    !count(progress.totalBackupBytes, BATCH_LIMITS.maxTotalFileBytes) ||
    !count(progress.backupBytesCopied, progress.totalBackupBytes) ||
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
  if (
    value.result !== null &&
    (value.error?.code !== value.result.error?.code ||
      value.error?.message !== value.result.error?.message ||
      value.error?.canRetry !== value.result.error?.canRetry)
  ) {
    return false
  }
  if (value.status === 'preparing' || value.status === 'ready' || value.status === 'running') {
    return value.result === null && value.error === null
  }
  if (value.status === 'unknown') {
    return value.error?.code === 'result-unknown'
  }
  if (value.error?.code === 'result-unknown') {
    return false
  }
  if (value.result !== null) {
    const files = value.result.outcomes.filter(
      (item) => item.status === 'succeeded' && isSyncFileWrite(item.action),
    )
    if (
      files.length !== progress.publishedFiles ||
      files.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0) !== progress.fileBytesPublished
    ) {
      return false
    }
  }
  if (value.status === 'succeeded') {
    return (
      value.result !== null &&
      value.result.error === null &&
      value.error === null &&
      value.result.outcomes.every((item) => item.status === 'succeeded')
    )
  }
  if (value.status === 'cancelled') {
    return (
      value.error === null &&
      (value.result === null || value.result.outcomes.some((item) => item.status === 'cancelled'))
    )
  }
  return value.status === 'failed' && value.error !== null
}
/**
 * 用原生插件创建 AndroidSyncWriteApi。
 *
 * @returns 参数无效、返回格式不对，或 ID、计划和结果与请求不符时，对应方法返回错误结果。
 */
export function createSyncWriteBridge(
  plugin: SyncWriteNativePlugin,
  isAndroid: () => boolean,
): AndroidSyncWriteApi {
  const plans = new Map<string, SyncPlan>()
  function remember(restoreId: string, plan: SyncPlan): void {
    if (!plans.has(restoreId) && plans.size >= 32) {
      const oldest = plans.keys().next().value
      if (oldest !== undefined) {
        plans.delete(oldest)
      }
    }
    plans.set(restoreId, structuredClone(plan))
  }
  async function invoke<T>(
    work: () => Promise<unknown>,
    guard: (value: unknown) => value is T,
  ): Promise<OperationResult<T>> {
    if (!isAndroid()) {
      return invalid('unsupported-operation')
    }
    try {
      const result = await work()
      return isOperationResult(result, guard) ? result : invalid('internal-error')
    } catch {
      return invalid('internal-error')
    }
  }
  async function preview(restoreId: string): Promise<OperationResult<SyncPlan>> {
    if (!isOpaqueId(restoreId)) {
      return invalid('invalid-request')
    }
    const result = await invoke(
      () => plugin.preview({ restoreId }),
      (value): value is Record<string, unknown> =>
        shape(value, ['restoreId', 'planId', 'projectId', 'source', 'target']) &&
        value.restoreId === restoreId &&
        isOpaqueId(value.planId) &&
        isOpaqueId(value.projectId) &&
        isSyncSnapshot(value.source) &&
        isSyncSnapshot(value.target),
    )
    if (result.status === 'error') {
      return result
    }
    const value = result.value
    if (
      !isSyncSnapshot(value.source) ||
      !isSyncSnapshot(value.target) ||
      !isOpaqueId(value.planId) ||
      !isOpaqueId(value.projectId)
    ) {
      return invalid('internal-error')
    }
    const plan = createSyncPlan({
      planId: value.planId,
      projectId: value.projectId,
      operation: 'restore',
      direction: 'local-restore',
      shouldBackup: true,
      shouldDeleteExtras: true,
      source: value.source,
      target: value.target,
    })
    remember(restoreId, plan)
    return { status: 'success', value: plan }
  }
  async function state(
    work: () => Promise<unknown>,
    expected: { restoreId?: string; projectId?: string; rootId?: string; backupId?: string },
  ): Promise<OperationResult<AndroidRestoreState>> {
    const result = await invoke(work, isState)
    if (result.status === 'error') {
      return result
    }
    const value = result.value
    if (
      Object.entries(expected).some(
        ([key, expectedValue]) => value[key as keyof AndroidRestoreState] !== expectedValue,
      )
    ) {
      return invalid('internal-error')
    }
    if (value.result !== null) {
      let plan = plans.get(value.restoreId)
      if (!plan) {
        const prepared = await preview(value.restoreId)
        if (prepared.status === 'error') {
          return prepared
        }
        plan = prepared.value
      }
      if (
        plan.projectId !== value.projectId ||
        plan.target.rootId !== value.rootId ||
        plan.source.rootId !== value.backupId ||
        !matchesSyncApplyResult(value.result, plan)
      ) {
        return invalid('internal-error')
      }
    }
    return result
  }
  return Object.freeze({
    bindProject: (projectId: string, rootId: string) =>
      ![projectId, rootId].every(isOpaqueId)
        ? Promise.resolve(invalid('invalid-request'))
        : invoke(
            () => plugin.bindProject({ projectId, rootId }),
            (value): value is null => value === null,
          ),
    prepareRestore: (projectId: string, rootId: string, backupId: string) =>
      ![projectId, rootId, backupId].every(isOpaqueId)
        ? Promise.resolve(invalid('invalid-request'))
        : state(() => plugin.prepareRestore({ projectId, rootId, backupId }), {
            projectId,
            rootId,
            backupId,
          }),
    query: (restoreId: string) =>
      !isOpaqueId(restoreId)
        ? Promise.resolve(invalid('invalid-request'))
        : state(() => plugin.query({ restoreId }), { restoreId }),
    current: () =>
      invoke(
        () => plugin.current(),
        (value): value is string | null => value === null || isOpaqueId(value),
      ),
    preview,
    execute: (restoreId: string, plan: SyncPlan) => {
      if (
        !isOpaqueId(restoreId) ||
        !isSyncPlan(plan) ||
        !plan.canExecute ||
        plan.operation !== 'restore'
      ) {
        return Promise.resolve(invalid('invalid-request'))
      }
      remember(restoreId, plan)
      return state(() => plugin.execute({ restoreId, plan }), {
        restoreId,
        projectId: plan.projectId,
        rootId: plan.target.rootId,
        backupId: plan.source.rootId,
      })
    },
    cancel: (restoreId: string) =>
      !isOpaqueId(restoreId)
        ? Promise.resolve(invalid('invalid-request'))
        : state(() => plugin.cancel({ restoreId }), { restoreId }),
    release: async (restoreId: string) => {
      if (!isOpaqueId(restoreId)) {
        return invalid('invalid-request')
      }
      const result = await invoke(
        () => plugin.release({ restoreId }),
        (value): value is null => value === null,
      )
      if (result.status === 'success') {
        plans.delete(restoreId)
      }
      return result
    },
    retryCleanup: () =>
      invoke(
        () => plugin.retryCleanup(),
        (value): value is null => value === null,
      ),
    interruptedWrites: () => invoke(() => plugin.interrupted(), isInterruptedWriteList),
    dismissInterruptedWrite: (id: string) =>
      !isOpaqueId(id)
        ? Promise.resolve(invalid('invalid-request'))
        : invoke(
            () => plugin.dismissInterrupted({ id }),
            (value): value is null => value === null,
          ),
  })
}
