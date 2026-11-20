import {
  isBatchDeviceDescriptor,
  isDirectoryListing,
  isDirectoryReference,
  isDirectorySelectionResult,
  isOpaqueId,
  isOperationResult,
  isCatalogPush,
  isCatalogReply,
} from '@savedata-sync/shared'
import type {
  BatchDeviceDescriptor,
  DirectoryListing,
  DirectoryReference,
  DirectorySelectionResult,
  OperationError,
  OperationResult,
  CatalogPush,
  CatalogReply,
} from '@savedata-sync/shared'

/** 一个原生事件订阅。 */
export interface TransferSubscription {
  /** 取消订阅。 */
  remove(): Promise<void>
}
/** 设备连接和控制通道的原生插件；方法与 AndroidTransferApi 的同名方法对应，返回值未经校验。 */
export interface HttpTransferNativePlugin {
  connections(): Promise<unknown>
  deviceName(): Promise<unknown>
  selectDevice(options: { deviceId: string }): Promise<unknown>
  disconnectDevice(options: { deviceId: string }): Promise<unknown>
  exchangeCatalog(options: { deviceId: string; catalog: CatalogPush }): Promise<unknown>
  controlStates(): Promise<unknown>
  sendControl(options: { deviceId: string; message: string }): Promise<unknown>
  connect(options: { address: string }): Promise<unknown>
  disconnect(): Promise<unknown>
  chooseTarget(): Promise<unknown>
  requestNotifications(): Promise<unknown>
  listRemoteRoots(): Promise<unknown>
  listRemoteDirectory(options: { rootId: string; parentId: string | null }): Promise<unknown>
  addListener(
    event: 'controlMessage' | 'controlState',
    callback: (state: unknown) => void,
  ): Promise<TransferSubscription>
}
/** 设备连接和目录浏览接口。所有方法的失败都以错误结果返回。 */
export interface AndroidTransferApi {
  /** 列出已连接的设备。 */
  connections(): Promise<OperationResult<readonly BatchDeviceDescriptor[]>>
  /** 读取本机系统名称，与发给对方的设备名相同。 */
  deviceName(): Promise<OperationResult<string>>
  /** 把一台已连接的设备设为传输对象；有任务进行中时只能选当前设备，否则返回 busy。 */
  selectDevice(deviceId: string): Promise<OperationResult<BatchDeviceDescriptor>>
  /** 通知对方后断开一台设备。 */
  disconnectDevice(deviceId: string): Promise<OperationResult<null>>
  /** 与对方交换目录表，返回对方的游戏表和关联。 */
  exchangeCatalog(deviceId: string, catalog: CatalogPush): Promise<OperationResult<CatalogReply>>
  /** 连接 address 上的监听方设备。 */
  connect(address: string): Promise<OperationResult<BatchDeviceDescriptor>>
  /** 释放本机的连接会话，不通知对方。 */
  disconnect(): Promise<OperationResult<null>>
  /** 打开系统目录选择器，把所选目录登记为接收目标。 */
  chooseTarget(): Promise<DirectorySelectionResult>
  /** 需要时申请通知权限；value 表示是否允许通知。 */
  requestNotifications(): Promise<OperationResult<boolean>>
  /** 列出对方的根目录。 */
  listRemoteRoots(): Promise<OperationResult<readonly DirectoryReference[]>>
  /** 列出对方目录的一层；parentId 省略或为 null 时列根层。 */
  listRemoteDirectory(
    rootId: string,
    parentId?: string | null,
  ): Promise<OperationResult<DirectoryListing>>
}
const INVALID: OperationError = {
  code: 'invalid-request',
  message: 'The device or directory reference is invalid.',
  canRetry: false,
}
const BRIDGE: OperationError = {
  code: 'io-failure',
  message: 'The response does not match this operation.',
  canRetry: false,
}
const UNSUPPORTED: OperationError = {
  code: 'unsupported-operation',
  message: 'Connect devices in the Android app.',
  canRetry: false,
}
function failure(error: OperationError): {
  readonly status: 'error'
  readonly error: OperationError
} {
  return { status: 'error', error }
}
function isRootList(value: unknown): value is readonly DirectoryReference[] {
  return (
    Array.isArray(value) &&
    value.every(isDirectoryReference) &&
    new Set(value.map((root) => root.rootId)).size === value.length
  )
}

/**
 * 用原生插件创建 AndroidTransferApi；isAndroid 返回 false 时所有方法返回 unsupported-operation。
 *
 * @returns 返回值格式不对或与请求不符时，对应方法返回错误结果。
 */
export function createHttpTransferBridge(
  plugin: HttpTransferNativePlugin,
  isAndroid: () => boolean,
): AndroidTransferApi {
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
  return Object.freeze({
    deviceName: (): Promise<OperationResult<string>> =>
      invoke(
        () => plugin.deviceName(),
        (value): value is string =>
          typeof value === 'string' && value.length > 0 && value.length <= 128,
      ),
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
  })
}
