import {
  createSyncPlan,
  isOpaqueId,
  isOperationError,
  isOperationResult,
  isSyncApplyResult,
  isSyncPlan,
  isSyncSnapshot,
  matchesSyncApplyResult,
} from '@savedata-sync/shared'
import type {
  OperationError,
  OperationResult,
  SyncApplyResult,
  SyncPlan,
} from '@savedata-sync/shared'

/** 本机恢复状态与预览分开查询，避免控制 JSON 同时携带两份快照和完整结果。 */
export interface AndroidRestoreState {
  readonly restoreId: string
  readonly projectId: string
  readonly rootId: string
  readonly backupId: string
  readonly status: 'preparing' | 'ready' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  readonly result: SyncApplyResult | null
  readonly error: OperationError | null
}
export interface SyncWriteNativePlugin {
  bindProject(options: { projectId: string; rootId: string }): Promise<unknown>
  prepareRestore(options: { projectId: string; rootId: string; backupId: string }): Promise<unknown>
  query(options: { restoreId: string }): Promise<unknown>
  preview(options: { restoreId: string }): Promise<unknown>
  execute(options: { restoreId: string; plan: SyncPlan }): Promise<unknown>
  cancel(options: { restoreId: string }): Promise<unknown>
  release(options: { restoreId: string }): Promise<unknown>
  retryCleanup(): Promise<unknown>
}
/** 平台层先核对保存的游戏配置，再 bindProject；执行固定预览，文件内容和句柄始终由原生持有。 */
export interface AndroidSyncWriteApi {
  bindProject(projectId: string, rootId: string): Promise<OperationResult<null>>
  prepareRestore(
    projectId: string,
    rootId: string,
    backupId: string,
  ): Promise<OperationResult<AndroidRestoreState>>
  query(restoreId: string): Promise<OperationResult<AndroidRestoreState>>
  preview(restoreId: string): Promise<OperationResult<SyncPlan>>
  execute(restoreId: string, plan: SyncPlan): Promise<OperationResult<AndroidRestoreState>>
  cancel(restoreId: string): Promise<OperationResult<AndroidRestoreState>>
  release(restoreId: string): Promise<OperationResult<null>>
  retryCleanup(): Promise<OperationResult<null>>
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
  code: 'invalid-request' | 'io-failure' | 'unsupported-operation',
): OperationResult<never> {
  return {
    status: 'error',
    error: {
      code,
      message:
        code === 'unsupported-operation'
          ? '请在 Android 应用中恢复本机备份。'
          : '本机恢复参数或响应无效。',
      canRetry: false,
    },
  }
}
function isState(value: unknown): value is AndroidRestoreState {
  if (
    !shape(value, ['restoreId', 'projectId', 'rootId', 'backupId', 'status', 'result', 'error']) ||
    ![value.restoreId, value.projectId, value.rootId, value.backupId].every(isOpaqueId) ||
    !(value.error === null || isOperationError(value.error)) ||
    !(value.result === null || isSyncApplyResult(value.result))
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
/** 双重核对 ID、纯比较计划及逐项实际结果；页面重建后按原生 ID 取回预览和结果。 */
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
      return isOperationResult(result, guard) ? result : invalid('io-failure')
    } catch {
      return invalid('io-failure')
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
      return invalid('io-failure')
    }
    const plan = createSyncPlan({
      planId: value.planId,
      projectId: value.projectId,
      operation: 'restore',
      direction: 'local-restore',
      shouldBackup: true,
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
      return invalid('io-failure')
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
        return invalid('io-failure')
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
  })
}
