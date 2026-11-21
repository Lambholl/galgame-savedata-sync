import {
  isOpaqueId,
  isOperationResult,
  isPreviewLocalSource,
  isSyncPreparationPreview,
  isSyncPreparationState,
  isSyncProjectBinding,
  isSyncTransferState,
  matchesSyncJobState,
  matchesSyncPlan,
  syncPlanFromPreview,
} from '@savedata-sync/shared'
import type {
  OperationResult,
  SyncJobRequest,
  SyncPlan,
  SyncPreparationPreview,
  SyncPreparationState,
  SyncProjectBinding,
  SyncTransferState,
  SyncDirection,
} from '@savedata-sync/shared'

/** 复制任务的原生插件；方法与 AndroidSyncTransferApi 的同名方法对应，返回值未经校验。任务属于应用进程，不随页面销毁。 */
export interface SyncTransferNativePlugin {
  prepare(options: { binding: SyncProjectBinding; direction: SyncDirection }): Promise<unknown>
  queryPreparation(options: { preparationId: string }): Promise<unknown>
  preview(options: { preparationId: string }): Promise<unknown>
  cancelPreparation(options: { preparationId: string }): Promise<unknown>
  execute(options: { preparationId: string; plan: SyncPlan }): Promise<unknown>
  query(options: { jobId: string; shouldRefresh: boolean }): Promise<unknown>
  current(): Promise<unknown>
  latest(options: { projectId: string }): Promise<unknown>
  cancel(options: { jobId: string }): Promise<unknown>
  release(options: { preparationId: string }): Promise<unknown>
  retryCleanup(): Promise<unknown>
  addListener(
    event: 'peerJobStarted',
    callback: (event: unknown) => void,
  ): Promise<{ remove(): Promise<void> }>
}
/** 复制任务接口。所有方法的失败都以错误结果返回。 */
export interface AndroidSyncTransferApi {
  /** 开始扫描两端，准备一次复制。 */
  prepare(
    binding: SyncProjectBinding,
    direction: SyncDirection,
  ): Promise<OperationResult<SyncPreparationState>>
  /** 读取准备的状态。 */
  queryPreparation(preparationId: string): Promise<OperationResult<SyncPreparationState>>
  /** 读取准备好的预览。 */
  preview(preparationId: string): Promise<OperationResult<SyncPreparationPreview>>
  /** 取消准备。 */
  cancelPreparation(preparationId: string): Promise<OperationResult<SyncPreparationState>>
  /** 按计划执行；plan 必须由这次预览生成。 */
  execute(preparationId: string, plan: SyncPlan): Promise<OperationResult<SyncTransferState>>
  /** 读取复制任务两个角色的状态；shouldRefresh 为 true 时先向对方查询。 */
  query(jobId: string, shouldRefresh?: boolean): Promise<OperationResult<SyncTransferState>>
  /** 读取当前复制任务的 ID；没有时为 null。 */
  current(): Promise<OperationResult<string | null>>
  /** 这个本机项目最近一次任务的 ID；只查进程内登记表，不跨项目。 */
  latest(projectId: string): Promise<OperationResult<string | null>>
  /** 取消复制任务。 */
  cancel(jobId: string): Promise<OperationResult<SyncTransferState>>
  /** 释放准备。 */
  release(preparationId: string): Promise<OperationResult<null>>
  /** 重试复制任务的缓存清理。 */
  retryCleanup(): Promise<OperationResult<null>>
  /**
   * 订阅对方开始的复制任务：本机作为监听方、对方没经本机请求就登记了任务时调用 listener，projectId 是本机的项目。
   *
   * @returns 撤销订阅的函数。
   */
  onPeerJobStarted(listener: (jobId: string, projectId: string) => void): () => void
}
function failure(
  code: 'invalid-request' | 'internal-error' | 'unsupported-operation',
): OperationResult<never> {
  return {
    status: 'error',
    error: {
      code,
      message:
        code === 'unsupported-operation'
          ? 'Start sync in the Android app.'
          : 'Sync parameters or the response are invalid.',
      canRetry: false,
    },
  }
}
function request(preview: SyncPreparationPreview): SyncJobRequest {
  const isLocalSource = isPreviewLocalSource(preview)
  return {
    schemaVersion: 1,
    jobId: preview.preparationId,
    sourceProjectId: isLocalSource ? preview.binding.projectId : preview.binding.remoteProjectId,
    targetProjectId: isLocalSource ? preview.binding.remoteProjectId : preview.binding.projectId,
    plan: syncPlanFromPreview(preview),
  }
}
/**
 * 用原生插件创建 AndroidSyncTransferApi。
 *
 * @returns 参数无效、返回格式不对，或计划和结果不属于同一次任务时，对应方法返回错误结果。
 */
export function createSyncTransferBridge(
  plugin: SyncTransferNativePlugin,
  isAndroid: () => boolean,
): AndroidSyncTransferApi {
  /** 按准备 ID 和任务 ID 记住的预览；本机作为监听方时两者不同，任务 ID 是预览里的 preparationId。 */
  const previews = new Map<string, SyncPreparationPreview>()
  const peerJobListeners = new Set<(jobId: string, projectId: string) => void>()
  let isSubscribed = false
  async function invoke<T>(
    work: () => Promise<unknown>,
    guard: (value: unknown) => value is T,
  ): Promise<OperationResult<T>> {
    if (!isAndroid()) {
      return failure('unsupported-operation')
    }
    try {
      const result = await work()
      return isOperationResult(result, guard) ? result : failure('internal-error')
    } catch {
      return failure('internal-error')
    }
  }
  function remember(value: SyncPreparationPreview, id = value.preparationId): void {
    for (const key of new Set([id, value.preparationId])) {
      if (!previews.has(key) && previews.size >= 64) {
        const oldest = previews.keys().next().value
        if (oldest !== undefined) {
          previews.delete(oldest)
        }
      }
      previews.set(key, structuredClone(value))
    }
  }
  async function preview(preparationId: string): Promise<OperationResult<SyncPreparationPreview>> {
    if (!isOpaqueId(preparationId)) {
      return failure('invalid-request')
    }
    const result = await invoke(
      () => plugin.preview({ preparationId }),
      // 本机作为监听方时用请求 ID 查到的预览带的是计划 ID。
      (value): value is SyncPreparationPreview =>
        isSyncPreparationPreview(value) &&
        (value.preparationId === preparationId || value.localSide === 'listener'),
    )
    if (result.status === 'success') {
      remember(result.value, preparationId)
    }
    return result
  }
  async function context(id: string): Promise<OperationResult<SyncPreparationPreview>> {
    const cached = previews.get(id)
    return cached ? { status: 'success', value: structuredClone(cached) } : preview(id)
  }
  async function validate(
    jobId: string,
    raw: OperationResult<SyncTransferState>,
  ): Promise<OperationResult<SyncTransferState>> {
    if (raw.status === 'error') {
      return raw
    }
    const restored = await context(jobId)
    if (restored.status === 'error') {
      return restored
    }
    const expected = request(restored.value),
      state = raw.value
    const localRole = isPreviewLocalSource(restored.value) ? 'sender' : 'receiver'
    return state.jobId === jobId &&
      state.local.role === localRole &&
      matchesSyncJobState(state.local, expected) &&
      (state.remote === null || matchesSyncJobState(state.remote, expected))
      ? raw
      : failure('internal-error')
  }
  async function query(
    jobId: string,
    shouldRefresh = false,
  ): Promise<OperationResult<SyncTransferState>> {
    if (!isOpaqueId(jobId) || typeof shouldRefresh !== 'boolean') {
      return failure('invalid-request')
    }
    return validate(
      jobId,
      await invoke(() => plugin.query({ jobId, shouldRefresh }), isSyncTransferState),
    )
  }
  async function preparationState(
    id: string,
    shouldCancel: boolean,
  ): Promise<OperationResult<SyncPreparationState>> {
    if (!isOpaqueId(id)) {
      return failure('invalid-request')
    }
    return invoke(
      () =>
        shouldCancel
          ? plugin.cancelPreparation({ preparationId: id })
          : plugin.queryPreparation({ preparationId: id }),
      (value): value is SyncPreparationState =>
        isSyncPreparationState(value) && value.preparationId === id,
    )
  }
  return {
    async prepare(binding, direction) {
      if (
        !isSyncProjectBinding(binding) ||
        !['dialer-to-listener', 'listener-to-dialer'].includes(direction)
      ) {
        return failure('invalid-request')
      }
      return invoke(
        () => plugin.prepare({ binding, direction }),
        (value): value is SyncPreparationState =>
          isSyncPreparationState(value) && value.direction === direction,
      )
    },
    queryPreparation: (id) => preparationState(id, false),
    preview,
    cancelPreparation: (id) => preparationState(id, true),
    async execute(preparationId, plan) {
      if (!isOpaqueId(preparationId)) {
        return failure('invalid-request')
      }
      const restored = await context(preparationId)
      if (restored.status === 'error') {
        return restored
      }
      // 开关的选择只在确认时给出；两份快照必须仍是这次预览的。
      const chosen = { ...restored.value, shouldDeleteExtras: plan.shouldDeleteExtras }
      const expected = request(chosen).plan
      if (
        !expected.canExecute ||
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
        return failure('invalid-request')
      }
      remember(chosen, preparationId)
      return validate(
        chosen.preparationId,
        await invoke(() => plugin.execute({ preparationId, plan }), isSyncTransferState),
      )
    },
    query,
    current: () =>
      invoke(
        () => plugin.current(),
        (value): value is string | null => value === null || isOpaqueId(value),
      ),
    async latest(projectId) {
      if (!isOpaqueId(projectId)) {
        return failure('invalid-request')
      }
      return invoke(
        () => plugin.latest({ projectId }),
        (value): value is string | null => value === null || isOpaqueId(value),
      )
    },
    async cancel(jobId) {
      if (!isOpaqueId(jobId)) {
        return failure('invalid-request')
      }
      return validate(jobId, await invoke(() => plugin.cancel({ jobId }), isSyncTransferState))
    },
    async release(preparationId) {
      if (!isOpaqueId(preparationId)) {
        return failure('invalid-request')
      }
      const result = await invoke(
        () => plugin.release({ preparationId }),
        (value): value is null => value === null,
      )
      if (result.status === 'success') {
        previews.delete(preparationId)
      }
      return result
    },
    retryCleanup: () =>
      invoke(
        () => plugin.retryCleanup(),
        (value): value is null => value === null,
      ),
    onPeerJobStarted(listener) {
      if (!isSubscribed && isAndroid()) {
        isSubscribed = true
        plugin
          .addListener('peerJobStarted', (event) => {
            if (
              typeof event === 'object' &&
              event !== null &&
              'jobId' in event &&
              'projectId' in event &&
              isOpaqueId(event.jobId) &&
              isOpaqueId(event.projectId)
            ) {
              for (const item of [...peerJobListeners]) {
                item(event.jobId, event.projectId)
              }
            }
          })
          .catch((cause: unknown) => console.error('Failed to listen for peer sync tasks', cause))
      }
      peerJobListeners.add(listener)
      return () => peerJobListeners.delete(listener)
    },
  }
}
