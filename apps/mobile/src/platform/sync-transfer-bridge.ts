import {
  isOpaqueId,
  isOperationResult,
  isSyncPreparationPreview,
  isSyncPreparationState,
  isSyncProjectBinding,
  isSyncTransferState,
  matchesSyncJobManifest,
  matchesSyncJobState,
  matchesSyncPlan,
  syncPlanFromPreview,
} from '@savedata-sync/shared'
import type {
  BatchManifest,
  OperationResult,
  SyncJobRequest,
  SyncJobState,
  SyncPlan,
  SyncPreparationPreview,
  SyncPreparationState,
  SyncProjectBinding,
  SyncTransferState,
  TransferDirection,
} from '@savedata-sync/shared'

/** 原生实例属于应用进程，插件/页面销毁只关闭控制入口；文件内容从不经过此桥。 */
export interface SyncTransferNativePlugin {
  prepare(options: { binding: SyncProjectBinding; direction: TransferDirection }): Promise<unknown>
  queryPreparation(options: { preparationId: string }): Promise<unknown>
  preview(options: { preparationId: string }): Promise<unknown>
  cancelPreparation(options: { preparationId: string }): Promise<unknown>
  execute(options: { preparationId: string; plan: SyncPlan }): Promise<unknown>
  query(options: { jobId: string; refresh: boolean }): Promise<unknown>
  manifest(options: { jobId: string }): Promise<unknown>
  current(): Promise<unknown>
  cancel(options: { jobId: string }): Promise<unknown>
  release(options: { preparationId: string }): Promise<unknown>
  retryCleanup(): Promise<unknown>
}
/** 平台先核对保存的项目关联；prepare 为普通扫描，execute 前由平台请求传输通知权限。 */
export interface AndroidSyncTransferApi {
  prepare(
    binding: SyncProjectBinding,
    direction: TransferDirection,
  ): Promise<OperationResult<SyncPreparationState>>
  queryPreparation(preparationId: string): Promise<OperationResult<SyncPreparationState>>
  preview(preparationId: string): Promise<OperationResult<SyncPreparationPreview>>
  cancelPreparation(preparationId: string): Promise<OperationResult<SyncPreparationState>>
  execute(preparationId: string, plan: SyncPlan): Promise<OperationResult<SyncTransferState>>
  query(jobId: string, shouldRefresh?: boolean): Promise<OperationResult<SyncTransferState>>
  manifest(jobId: string): Promise<OperationResult<BatchManifest | null>>
  current(): Promise<OperationResult<string | null>>
  cancel(jobId: string): Promise<OperationResult<SyncTransferState>>
  release(preparationId: string): Promise<OperationResult<null>>
  retryCleanup(): Promise<OperationResult<null>>
}
function failure(
  code: 'invalid-request' | 'io-failure' | 'unsupported-operation',
): OperationResult<never> {
  return {
    status: 'error',
    error: {
      code,
      message:
        code === 'unsupported-operation'
          ? '请在 Android 应用中发起同步。'
          : '本次同步参数或响应无效。',
      canRetry: false,
    },
  }
}
function request(preview: SyncPreparationPreview): SyncJobRequest {
  const isUpload = preview.direction === 'android-to-windows'
  return {
    schemaVersion: 1,
    jobId: preview.preparationId,
    sourceProjectId: isUpload ? preview.binding.projectId : preview.binding.remoteProjectId,
    targetProjectId: isUpload ? preview.binding.remoteProjectId : preview.binding.projectId,
    plan: syncPlanFromPreview(preview),
  }
}
/** 以原生预览恢复同次上下文，逐项核对计划、清单及两个角色结果；有界缓存最多 32 次。 */
export function createSyncTransferBridge(
  plugin: SyncTransferNativePlugin,
  isAndroid: () => boolean,
): AndroidSyncTransferApi {
  const previews = new Map<string, SyncPreparationPreview>()
  const manifests = new Map<string, BatchManifest>()
  async function invoke<T>(
    work: () => Promise<unknown>,
    guard: (value: unknown) => value is T,
  ): Promise<OperationResult<T>> {
    if (!isAndroid()) {
      return failure('unsupported-operation')
    }
    try {
      const result = await work()
      return isOperationResult(result, guard) ? result : failure('io-failure')
    } catch {
      return failure('io-failure')
    }
  }
  function remember(value: SyncPreparationPreview): void {
    if (!previews.has(value.preparationId) && previews.size >= 32) {
      const oldest = previews.keys().next().value
      if (oldest !== undefined) {
        previews.delete(oldest)
        manifests.delete(oldest)
      }
    }
    previews.set(value.preparationId, structuredClone(value))
  }
  async function preview(preparationId: string): Promise<OperationResult<SyncPreparationPreview>> {
    if (!isOpaqueId(preparationId)) {
      return failure('invalid-request')
    }
    const result = await invoke(
      () => plugin.preview({ preparationId }),
      (value): value is SyncPreparationPreview =>
        isSyncPreparationPreview(value) && value.preparationId === preparationId,
    )
    if (result.status === 'success') {
      remember(result.value)
    }
    return result
  }
  async function context(id: string): Promise<OperationResult<SyncPreparationPreview>> {
    const cached = previews.get(id)
    return cached ? { status: 'success', value: structuredClone(cached) } : preview(id)
  }
  async function manifest(jobId: string): Promise<OperationResult<BatchManifest | null>> {
    if (!isOpaqueId(jobId)) {
      return failure('invalid-request')
    }
    const restored = await context(jobId)
    if (restored.status === 'error') {
      return restored
    }
    const expected = request(restored.value)
    const result = await invoke(
      () => plugin.manifest({ jobId }),
      (value): value is BatchManifest | null =>
        value === null || matchesSyncJobManifest(value, expected),
    )
    if (result.status === 'success' && result.value !== null) {
      const previous = manifests.get(jobId)
      if (
        previous &&
        (previous.archive.sha256 !== result.value.archive.sha256 ||
          previous.archive.sizeBytes !== result.value.archive.sizeBytes)
      ) {
        return failure('io-failure')
      }
      manifests.set(jobId, structuredClone(result.value))
    }
    return result
  }
  function hasMatchingState(
    state: SyncJobState,
    expected: SyncJobRequest,
    declared: BatchManifest | null,
  ): boolean {
    const needManifest =
      expected.plan.transferFileCount > 0 && state.progress.totalArchiveBytes !== null
    return (
      (!needManifest || declared !== null) &&
      matchesSyncJobState(state, expected, needManifest ? declared : null)
    )
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
    const localRole = restored.value.direction === 'android-to-windows' ? 'sender' : 'receiver'
    let declared = manifests.get(jobId) ?? null
    if (
      expected.plan.transferFileCount > 0 &&
      (state.local.progress.totalArchiveBytes !== null ||
        (state.remote !== null && state.remote.progress.totalArchiveBytes !== null)) &&
      declared === null
    ) {
      const result = await manifest(jobId)
      if (result.status === 'error') {
        return result
      }
      declared = result.value
    }
    return state.jobId === jobId &&
      state.local.role === localRole &&
      hasMatchingState(state.local, expected, declared) &&
      (state.remote === null || hasMatchingState(state.remote, expected, declared))
      ? raw
      : failure('io-failure')
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
      await invoke(() => plugin.query({ jobId, refresh: shouldRefresh }), isSyncTransferState),
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
        !['android-to-windows', 'windows-to-android'].includes(direction)
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
      const expected = request(restored.value).plan
      if (
        !expected.canExecute ||
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
        return failure('invalid-request')
      }
      return validate(
        preparationId,
        await invoke(() => plugin.execute({ preparationId, plan }), isSyncTransferState),
      )
    },
    query,
    manifest,
    current: () =>
      invoke(
        () => plugin.current(),
        (value): value is string | null => value === null || isOpaqueId(value),
      ),
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
        manifests.delete(preparationId)
      }
      return result
    },
    retryCleanup: () =>
      invoke(
        () => plugin.retryCleanup(),
        (value): value is null => value === null,
      ),
  }
}
