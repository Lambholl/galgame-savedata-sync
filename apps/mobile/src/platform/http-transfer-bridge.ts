import {
  isBatchDeviceDescriptor,
  isBatchManifest,
  isBatchState,
  isDirectoryListing,
  isDirectoryReference,
  isDirectorySelectionResult,
  isDownloadBatchRequest,
  isOpaqueId,
  isOperationResult,
  isTargetSelection,
  matchesBatchState,
  isCatalogPush,
  isCatalogReply,
} from '@savedata-sync/shared'
import type {
  BatchDeviceDescriptor,
  BatchManifest,
  BatchState,
  DirectoryListing,
  DirectoryReference,
  DirectorySelectionResult,
  DownloadBatchRequest,
  OperationError,
  OperationResult,
  TargetSelection,
  CatalogPush,
  CatalogReply,
} from '@savedata-sync/shared'

/** 同一批内 source/target 分开；实际方向由方法确定，不接受路径、URI 或字节。 */
export interface TransferStartOptions {
  readonly request: DownloadBatchRequest
  readonly targetRootId: string
  readonly targets: readonly TargetSelection[]
}
export interface TransferHandle {
  readonly transferId: string
}
/** Activity 重建后重新取得同一任务的元数据上下文；不会启动或重放传输。 */
export interface CurrentTransfer {
  readonly options: TransferStartOptions
  readonly upload: boolean
  readonly device: BatchDeviceDescriptor
}
export interface TransferSubscription {
  remove(): Promise<void>
}
/** Capacitor 内部绑定；未知响应必须先经过守卫和本次上下文匹配。 */
export interface HttpTransferNativePlugin {
  connections(): Promise<unknown>
  selectDevice(options: { deviceId: string }): Promise<unknown>
  disconnectDevice(options: { deviceId: string }): Promise<unknown>
  exchangeCatalog(options: { deviceId: string; catalog: CatalogPush }): Promise<unknown>
  connect(options: { address: string }): Promise<unknown>
  disconnect(): Promise<unknown>
  chooseTarget(): Promise<unknown>
  requestNotifications(): Promise<unknown>
  current(): Promise<unknown>
  listRemoteRoots(): Promise<unknown>
  listRemoteDirectory(options: { rootId: string; parentId: string | null }): Promise<unknown>
  startDownload(options: TransferStartOptions): Promise<unknown>
  startUpload(options: TransferStartOptions): Promise<unknown>
  query(options: TransferHandle): Promise<unknown>
  queryRemote(options: TransferHandle & { refresh: boolean }): Promise<unknown>
  getManifest(options: TransferHandle): Promise<unknown>
  cancel(options: TransferHandle): Promise<unknown>
  retryCleanup(): Promise<unknown>
  addListener(
    event: 'transferState',
    callback: (state: unknown) => void,
  ): Promise<TransferSubscription>
}
/** 所有 Promise resolve 脱敏结果；任务 ID 单次使用，取消及查询均不自动重放网络请求。 */
export interface AndroidTransferApi {
  connections(): Promise<OperationResult<readonly BatchDeviceDescriptor[]>>
  selectDevice(deviceId: string): Promise<OperationResult<BatchDeviceDescriptor>>
  disconnectDevice(deviceId: string): Promise<OperationResult<null>>
  exchangeCatalog(deviceId: string, catalog: CatalogPush): Promise<OperationResult<CatalogReply>>
  connect(address: string): Promise<OperationResult<BatchDeviceDescriptor>>
  disconnect(): Promise<OperationResult<null>>
  chooseTarget(): Promise<DirectorySelectionResult>
  requestNotifications(): Promise<OperationResult<boolean>>
  current(): Promise<OperationResult<CurrentTransfer | null>>
  listRemoteRoots(): Promise<OperationResult<readonly DirectoryReference[]>>
  listRemoteDirectory(
    rootId: string,
    parentId?: string | null,
  ): Promise<OperationResult<DirectoryListing>>
  startDownload(options: TransferStartOptions): Promise<OperationResult<TransferHandle>>
  startUpload(options: TransferStartOptions): Promise<OperationResult<TransferHandle>>
  query(transferId: string): Promise<OperationResult<BatchState>>
  queryRemote(transferId: string, shouldRefresh?: boolean): Promise<OperationResult<BatchState>>
  getManifest(transferId: string): Promise<OperationResult<BatchManifest>>
  cancel(transferId: string): Promise<OperationResult<null>>
  retryCleanup(): Promise<OperationResult<boolean>>
  subscribe(
    listener: (state: OperationResult<BatchState>) => void,
  ): Promise<OperationResult<TransferSubscription>>
}
const INVALID: OperationError = {
  code: 'invalid-request',
  message: '传输参数或任务引用无效。',
  canRetry: false,
}
const BRIDGE: OperationError = {
  code: 'io-failure',
  message: '任务响应与本次操作不匹配。',
  canRetry: false,
}
const UNSUPPORTED: OperationError = {
  code: 'unsupported-operation',
  message: '请在 Android 应用中操作传输。',
  canRetry: false,
}
function failure(error: OperationError): {
  readonly status: 'error'
  readonly error: OperationError
} {
  return { status: 'error', error }
}
function isHandle(value: unknown): value is TransferHandle {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.keys(value).length === 1 &&
    'transferId' in value &&
    isOpaqueId(value.transferId)
  )
}
function isRootList(value: unknown): value is readonly DirectoryReference[] {
  return (
    Array.isArray(value) &&
    value.every(isDirectoryReference) &&
    new Set(value.map((root) => root.rootId)).size === value.length
  )
}
function isStartOptions(value: unknown): value is TransferStartOptions {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('request' in value) ||
    !('targetRootId' in value) ||
    !('targets' in value) ||
    Object.keys(value).length !== 3 ||
    !isDownloadBatchRequest(value.request) ||
    !isOpaqueId(value.targetRootId) ||
    !Array.isArray(value.targets) ||
    value.targets.length !== value.request.files.length ||
    !value.targets.every(isTargetSelection)
  ) {
    return false
  }
  const ids = new Set(value.request.files.map((file) => file.fileId))
  return (
    new Set(value.targets.map((target) => target.fileId)).size === ids.size &&
    value.targets.every((target) => ids.has(target.fileId))
  )
}
interface TransferContext {
  readonly options: TransferStartOptions
  readonly upload: boolean
  readonly remoteDeviceId: string
  manifest?: BatchManifest
}

/**
 * 创建只含元数据/任务 DTO 的桥；上下文只在本进程保留。subscribe 返回的句柄必须 remove。
 * query 的 task-conflict 可表示下载仍在远端准备；queryRemote 可查看此时的 sender 状态。
 */
export function createHttpTransferBridge(
  plugin: HttpTransferNativePlugin,
  isAndroid: () => boolean,
): AndroidTransferApi {
  const contexts = new Map<string, TransferContext>()
  let device: BatchDeviceDescriptor | undefined
  async function invoke<T>(
    work: () => Promise<unknown>,
    guard: (value: unknown) => value is T,
    shouldPreserveErrorCode = false,
  ): Promise<OperationResult<T>> {
    if (!isAndroid()) {
      return failure(
        shouldPreserveErrorCode ? { ...UNSUPPORTED, message: UNSUPPORTED.code } : UNSUPPORTED,
      )
    }
    try {
      const response = await work()
      return isOperationResult(response, guard)
        ? response
        : failure(shouldPreserveErrorCode ? { ...BRIDGE, message: BRIDGE.code } : BRIDGE)
    } catch (error) {
      if (shouldPreserveErrorCode) {
        const code =
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          typeof error.code === 'string'
            ? error.code
            : error instanceof Error
              ? error.name
              : BRIDGE.code
        return failure({ ...BRIDGE, message: code })
      }
      return failure(BRIDGE)
    }
  }
  async function getManifest(transferId: string): Promise<OperationResult<BatchManifest>> {
    const context = contexts.get(transferId)
    if (!context) {
      return failure(INVALID)
    }
    const response = await invoke(() => plugin.getManifest({ transferId }), isBatchManifest)
    if (response.status === 'error') {
      return response
    }
    const manifest = response.value
    if (
      manifest.transferId !== transferId ||
      manifest.sourceRootId !== context.options.request.sourceRootId ||
      manifest.files.length !== context.options.request.files.length ||
      (!context.upload && manifest.sourceDeviceId !== context.remoteDeviceId) ||
      manifest.files.some(
        (file, index) => file.sourceEntryId !== context.options.request.files[index]?.entryId,
      )
    ) {
      return failure(BRIDGE)
    }
    if (context.manifest && JSON.stringify(context.manifest) !== JSON.stringify(manifest)) {
      return failure(BRIDGE)
    }
    context.manifest = structuredClone(manifest)
    return response
  }
  async function validateState(
    value: unknown,
    context: TransferContext,
    isRemote: boolean,
  ): Promise<OperationResult<BatchState>> {
    const id = context.options.request.transferId
    const direction = context.upload ? 'android-to-windows' : 'windows-to-android'
    const isSender = context.upload !== isRemote
    if (
      !isBatchState(value) ||
      value.transferId !== id ||
      value.direction !== direction ||
      value.role !== (isSender ? 'sender' : 'receiver') ||
      (value.status === 'running' &&
        value.progress.totalFiles !== context.options.request.files.length)
    ) {
      return failure(BRIDGE)
    }
    if (!context.manifest) {
      const response = await getManifest(id)
      if (response.status === 'error') {
        // 原生下载在清单生成前结束时，逐文件只能是本次选择的“未尝试”。
        if (
          !isRemote &&
          !context.upload &&
          value.role === 'receiver' &&
          response.error.code === 'task-conflict' &&
          (value.status === 'failed' || value.status === 'cancelled') &&
          value.fileResults.length === context.options.request.files.length &&
          value.fileResults.every(
            (result, index) =>
              result.fileId === context.options.request.files[index]?.fileId &&
              result.status === 'not-attempted' &&
              result.reason === (value.status === 'cancelled' ? 'cancelled' : 'batch-invalid'),
          )
        ) {
          return { status: 'success', value }
        }
        if (
          isSender &&
          response.error.code === 'task-conflict' &&
          (value.status === 'failed' ||
            value.status === 'cancelled' ||
            (value.status === 'running' && value.stage === 'preparing'))
        ) {
          return { status: 'success', value }
        }
        return failure(BRIDGE)
      }
    }
    const manifest = context.manifest
    const receiver = isSender
      ? undefined
      : {
          protocolVersion: 1 as const,
          manifest,
          targetRootId: context.options.targetRootId,
          targets: context.options.targets,
        }
    return matchesBatchState(value, manifest, direction, receiver)
      ? { status: 'success', value }
      : failure(BRIDGE)
  }
  async function query(
    transferId: string,
    isRemote: boolean,
    shouldRefresh: boolean,
  ): Promise<OperationResult<BatchState>> {
    const context = contexts.get(transferId)
    if (!context) {
      return failure(INVALID)
    }
    const response = await invoke(
      () =>
        isRemote
          ? plugin.queryRemote({ transferId, refresh: shouldRefresh })
          : plugin.query({ transferId }),
      isBatchState,
    )
    if (response.status === 'error') {
      return response
    }
    return validateState(response.value, context, isRemote)
  }
  async function start(
    options: TransferStartOptions,
    isUpload: boolean,
  ): Promise<OperationResult<TransferHandle>> {
    if (!isStartOptions(options) || contexts.has(options.request.transferId)) {
      return failure(INVALID)
    }
    if (!isAndroid()) {
      return failure(UNSUPPORTED)
    }
    if (!device) {
      return failure(INVALID)
    }
    const stable = structuredClone(options)
    const id = stable.request.transferId
    // 原生事件可能先于 start 的回执到达；先保存上下文，失败后撤回。
    contexts.set(id, { options: stable, upload: isUpload, remoteDeviceId: device.device.deviceId })
    const response = await invoke(
      () => (isUpload ? plugin.startUpload(stable) : plugin.startDownload(stable)),
      isHandle,
    )
    if (response.status === 'error' || response.value.transferId !== id) {
      contexts.delete(id)
      return response.status === 'error' ? response : failure(BRIDGE)
    }
    return response
  }
  return Object.freeze({
    connections: (): Promise<OperationResult<readonly BatchDeviceDescriptor[]>> =>
      invoke(
        () => plugin.connections(),
        (value): value is readonly BatchDeviceDescriptor[] =>
          Array.isArray(value) &&
          value.length <= 1 &&
          value.every(isBatchDeviceDescriptor) &&
          value.every((item) => item.device.platform === 'windows'),
      ),
    async selectDevice(deviceId: string): Promise<OperationResult<BatchDeviceDescriptor>> {
      if (!isOpaqueId(deviceId)) {
        return failure(INVALID)
      }
      const result = await invoke(() => plugin.selectDevice({ deviceId }), isBatchDeviceDescriptor)
      if (result.status === 'success') {
        if (
          result.value.device.deviceId !== deviceId ||
          result.value.device.platform !== 'windows'
        ) {
          return failure(BRIDGE)
        }
        device = structuredClone(result.value)
      }
      return result
    },
    async disconnectDevice(deviceId: string): Promise<OperationResult<null>> {
      if (!isOpaqueId(deviceId)) {
        return failure(INVALID)
      }
      const result = await invoke(
        () => plugin.disconnectDevice({ deviceId }),
        (value): value is null => value === null,
      )
      if (result.status === 'success' && device?.device.deviceId === deviceId) {
        device = undefined
      }
      return result
    },
    exchangeCatalog: (
      deviceId: string,
      catalog: CatalogPush,
    ): Promise<OperationResult<CatalogReply>> =>
      isOpaqueId(deviceId) && isCatalogPush(catalog)
        ? invoke(() => plugin.exchangeCatalog({ deviceId, catalog }), isCatalogReply, true)
        : Promise.resolve(failure({ ...INVALID, message: INVALID.code })),
    async connect(address: string): Promise<OperationResult<BatchDeviceDescriptor>> {
      if (typeof address !== 'string' || address.length > 256) {
        return failure({ ...INVALID, message: INVALID.code })
      }
      const response = await invoke(
        () => plugin.connect({ address }),
        isBatchDeviceDescriptor,
        true,
      )
      if (response.status === 'success') {
        if (response.value.device.platform !== 'windows') {
          return failure({ ...BRIDGE, message: BRIDGE.code })
        }
        device = structuredClone(response.value)
      }
      return response
    },
    async disconnect(): Promise<OperationResult<null>> {
      const result = await invoke(
        () => plugin.disconnect(),
        (value): value is null => value === null,
      )
      if (result.status === 'success') {
        device = undefined
        contexts.clear()
      }
      return result
    },
    async chooseTarget(): Promise<DirectorySelectionResult> {
      if (!isAndroid()) {
        return failure(UNSUPPORTED)
      }
      try {
        const response = await plugin.chooseTarget()
        return isDirectorySelectionResult(response) ? response : failure(BRIDGE)
      } catch {
        return failure(BRIDGE)
      }
    },
    requestNotifications: (): Promise<OperationResult<boolean>> =>
      invoke(
        () => plugin.requestNotifications(),
        (value): value is boolean => typeof value === 'boolean',
      ),
    async current(): Promise<OperationResult<CurrentTransfer | null>> {
      const response = await invoke(
        () => plugin.current(),
        (value): value is CurrentTransfer | null =>
          value === null ||
          (typeof value === 'object' &&
            Object.keys(value).length === 3 &&
            'options' in value &&
            'upload' in value &&
            'device' in value &&
            isStartOptions(value.options) &&
            typeof value.upload === 'boolean' &&
            isBatchDeviceDescriptor(value.device) &&
            value.device.device.platform === 'windows'),
      )
      if (response.status === 'success' && response.value !== null) {
        const value = structuredClone(response.value)
        device ??= structuredClone(value.device)
        contexts.set(value.options.request.transferId, {
          options: value.options,
          upload: value.upload,
          remoteDeviceId: value.device.device.deviceId,
        })
      }
      return response
    },
    async listRemoteRoots(): Promise<OperationResult<readonly DirectoryReference[]>> {
      const result = await invoke(() => plugin.listRemoteRoots(), isRootList)
      return result.status === 'success' &&
        result.value.some((root) => root.deviceId !== device?.device.deviceId)
        ? failure(BRIDGE)
        : result
    },
    async listRemoteDirectory(
      rootId: string,
      parentId: string | null = null,
    ): Promise<OperationResult<DirectoryListing>> {
      if (!isOpaqueId(rootId) || (parentId !== null && !isOpaqueId(parentId))) {
        return failure(INVALID)
      }
      const result = await invoke(
        () => plugin.listRemoteDirectory({ rootId, parentId }),
        isDirectoryListing,
      )
      return result.status === 'success' &&
        (result.value.rootId !== rootId || result.value.parentId !== parentId)
        ? failure(BRIDGE)
        : result
    },
    startDownload: (options: TransferStartOptions): Promise<OperationResult<TransferHandle>> =>
      start(options, false),
    startUpload: (options: TransferStartOptions): Promise<OperationResult<TransferHandle>> =>
      start(options, true),
    query: (transferId: string): Promise<OperationResult<BatchState>> =>
      query(transferId, false, false),
    queryRemote: (
      transferId: string,
      shouldRefresh = false,
    ): Promise<OperationResult<BatchState>> => query(transferId, true, shouldRefresh),
    getManifest,
    async cancel(transferId: string): Promise<OperationResult<null>> {
      if (!contexts.has(transferId)) {
        return failure(INVALID)
      }
      return invoke(
        () => plugin.cancel({ transferId }),
        (value): value is null => value === null,
      )
    },
    retryCleanup: (): Promise<OperationResult<boolean>> =>
      invoke(
        () => plugin.retryCleanup(),
        (value): value is boolean => typeof value === 'boolean',
      ),
    async subscribe(
      listener: (state: OperationResult<BatchState>) => void,
    ): Promise<OperationResult<TransferSubscription>> {
      if (!isAndroid()) {
        return failure(UNSUPPORTED)
      }
      try {
        let isActive = true
        let pending: Promise<void> = Promise.resolve()
        function notify(state: OperationResult<BatchState>): void {
          if (!isActive) {
            return
          }
          try {
            listener(state)
          } catch {
            // 订阅者异常不改写原生任务结果；调用者仍可 query 核实。
          }
        }
        const handle = await plugin.addListener('transferState', (state) => {
          if (!isActive) {
            return
          }
          pending = pending
            .then(async () => {
              if (!isActive) {
                return
              }
              const context = isBatchState(state) ? contexts.get(state.transferId) : undefined
              if (!context) {
                notify(failure(BRIDGE))
                return
              }
              notify(await validateState(state, context, false))
            })
            .catch(() => {
              notify(failure(BRIDGE))
            })
        })
        return {
          status: 'success',
          value: {
            async remove(): Promise<void> {
              isActive = false
              await handle.remove()
            },
          },
        }
      } catch {
        return failure(BRIDGE)
      }
    },
  })
}
