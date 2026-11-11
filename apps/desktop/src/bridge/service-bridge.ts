import {
  isBatchState,
  isDirectoryReference,
  isDirectorySelectionResult,
  isIpv4Address,
  isOpaqueId,
  isOperationError,
  isOperationResult,
  isSyncScanState,
  MAX_CANDIDATE_ADDRESSES,
} from '@savedata-sync/shared'
import type {
  BatchState,
  DirectoryReference,
  DirectorySelectionResult,
  OperationError,
  OperationResult,
  SyncScanState,
} from '@savedata-sync/shared'

/** 本机 HTTP 服务的状态快照。 */
export interface DesktopServiceSnapshot {
  /** 本机稳定设备 ID。 */
  readonly deviceId: string
  /** 本机系统名称；读取失败时为 null。 */
  readonly deviceName: string | null
  readonly configuredPort: number
  readonly listener: {
    readonly host: string
    readonly port: number
    /**
     * 本机 IPv4 地址（不含端口），按推荐顺序排列，第一个是推荐地址；最多 MAX_CANDIDATE_ADDRESSES 个。
     * 服务启动后还没读到时为 null，查询网卡失败或没有可用网卡时为空数组。
     */
    readonly ipv4Addresses: readonly string[] | null
    /** 开始监听的时间（Unix 毫秒）。 */
    readonly startedAt: number
  } | null
  readonly error: OperationError | null
  readonly discovery: DesktopDiscoveryState
  readonly targets: readonly DirectoryReference[]
  readonly tasks: readonly BatchState[]
}

/** 本机 HTTP 服务在局域网的 mDNS 广播状态。 */
export interface DesktopDiscoveryState {
  /**
   * off：服务未运行，没有广播。
   * starting：正在探测名称并宣告。
   * advertising：已在本机各网卡发出宣告；网卡增减或地址变化后自动重新宣告。
   * failed：注册失败；服务运行期间每 30 秒重新注册一次，成功后变为 advertising。
   */
  readonly status: 'off' | 'starting' | 'advertising' | 'failed'
  /** 正在广播的 DNS-SD 实例名，局域网里重名时带序号；不在 advertising 时为 null。 */
  readonly instanceName: string | null
  /** 最近一次注册失败的脱敏错误；只在 failed 时有值。 */
  readonly error: OperationError | null
}

const DISCOVERY_STATUSES: ReadonlySet<unknown> = new Set([
  'off',
  'starting',
  'advertising',
  'failed',
])

function isDiscoveryState(value: unknown): value is DesktopDiscoveryState {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    DISCOVERY_STATUSES.has(value.status) &&
    'instanceName' in value &&
    (value.instanceName === null || typeof value.instanceName === 'string') &&
    'error' in value &&
    (value.error === null || isOperationError(value.error))
  )
}

/** 服务接口的 IPC 通道名。 */
export const SERVICE_CHANNELS = {
  status: 'service:status',
  start: 'service:start',
  randomizePort: 'service:randomize-port',
  stop: 'service:stop',
  chooseTarget: 'service:choose-target',
  revokeTarget: 'service:revoke-target',
  cancel: 'service:cancel',
  cleanup: 'service:cleanup',
  scanStart: 'service:scan-start',
  scanQuery: 'service:scan-query',
  scanCancel: 'service:scan-cancel',
} as const

/** 本机 HTTP 服务的控制接口。所有方法的失败都以错误结果返回。 */
export interface DesktopServiceApi {
  /** 读取服务状态。 */
  status(): Promise<OperationResult<DesktopServiceSnapshot>>
  /** 在指定端口启动服务。 */
  start(port: number): Promise<OperationResult<DesktopServiceSnapshot>>
  /** 换一个随机端口；服务运行时返回 busy。 */
  randomizePort(): Promise<OperationResult<DesktopServiceSnapshot>>
  /** 停止服务。 */
  stop(): Promise<OperationResult<DesktopServiceSnapshot>>
  /** 打开系统目录选择器，把所选目录登记为接收目标。 */
  chooseTarget(): Promise<DirectorySelectionResult>
  /** 撤销一个接收目标的登记。 */
  revokeTarget(rootId: string): Promise<OperationResult<DesktopServiceSnapshot>>
  /** 取消一次批量传输。 */
  cancel(transferId: string): Promise<OperationResult<DesktopServiceSnapshot>>
  /** 重试失败的缓存清理。 */
  retryCleanup(): Promise<OperationResult<DesktopServiceSnapshot>>
  /** 开始扫描一个本机根目录。 */
  startScan(rootId: string): Promise<OperationResult<SyncScanState>>
  /** 读取扫描状态。 */
  queryScan(scanId: string): Promise<OperationResult<SyncScanState>>
  /** 取消扫描。 */
  cancelScan(scanId: string): Promise<OperationResult<SyncScanState>>
}

function isSnapshot(value: unknown): value is DesktopServiceSnapshot {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('deviceId' in value) ||
    !('deviceName' in value) ||
    !('configuredPort' in value) ||
    !('listener' in value) ||
    !('error' in value) ||
    !('discovery' in value) ||
    !('targets' in value) ||
    !('tasks' in value)
  ) {
    return false
  }
  const listener = value.listener
  return (
    isOpaqueId(value.deviceId) &&
    (value.deviceName === null ||
      (typeof value.deviceName === 'string' && value.deviceName.length > 0)) &&
    typeof value.configuredPort === 'number' &&
    Number.isInteger(value.configuredPort) &&
    value.configuredPort >= 1 &&
    value.configuredPort <= 65535 &&
    (listener === null ||
      (typeof listener === 'object' &&
        'host' in listener &&
        typeof listener.host === 'string' &&
        'port' in listener &&
        typeof listener.port === 'number' &&
        Number.isInteger(listener.port) &&
        listener.port > 0 &&
        listener.port <= 65535 &&
        'ipv4Addresses' in listener &&
        (listener.ipv4Addresses === null ||
          (Array.isArray(listener.ipv4Addresses) &&
            listener.ipv4Addresses.length <= MAX_CANDIDATE_ADDRESSES &&
            listener.ipv4Addresses.every(isIpv4Address))) &&
        'startedAt' in listener &&
        typeof listener.startedAt === 'number' &&
        Number.isSafeInteger(listener.startedAt))) &&
    (value.error === null || isOperationError(value.error)) &&
    isDiscoveryState(value.discovery) &&
    Array.isArray(value.targets) &&
    value.targets.every(isDirectoryReference) &&
    Array.isArray(value.tasks) &&
    value.tasks.every(isBatchState)
  )
}

/**
 * 用 invoke 创建冻结的 DesktopServiceApi。
 *
 * @returns invoke 失败或返回格式不对时，对应方法返回 io-failure 错误结果。
 */
export function createServiceBridge(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
): DesktopServiceApi {
  const failure = {
    status: 'error' as const,
    error: {
      code: 'io-failure' as const,
      message: '本地服务响应无效，请重新读取状态。',
      canRetry: false,
    },
  }
  async function call(
    channel: string,
    ...args: unknown[]
  ): Promise<OperationResult<DesktopServiceSnapshot>> {
    try {
      const result = await invoke(channel, ...args)
      return isOperationResult(result, isSnapshot) ? result : failure
    } catch {
      return failure
    }
  }
  async function scanCall(
    channel: string,
    key: 'rootId' | 'scanId',
    id: string,
  ): Promise<OperationResult<SyncScanState>> {
    if (!isOpaqueId(id)) {
      return failure
    }
    try {
      const result = await invoke(channel, { [key]: id })
      if (
        !isOperationResult(result, isSyncScanState) ||
        (result.status === 'success' && result.value[key] !== id)
      ) {
        return failure
      }
      return result
    } catch {
      return failure
    }
  }
  return Object.freeze({
    status: () => call(SERVICE_CHANNELS.status),
    start: (port: number) =>
      Number.isInteger(port) && port >= 1 && port <= 65535
        ? call(SERVICE_CHANNELS.start, { port })
        : Promise.resolve(failure),
    randomizePort: () => call(SERVICE_CHANNELS.randomizePort),
    stop: () => call(SERVICE_CHANNELS.stop),
    async chooseTarget(): Promise<DirectorySelectionResult> {
      try {
        const result = await invoke(SERVICE_CHANNELS.chooseTarget)
        return isDirectorySelectionResult(result) ? result : failure
      } catch {
        return failure
      }
    },
    revokeTarget: (rootId: string) =>
      isOpaqueId(rootId)
        ? call(SERVICE_CHANNELS.revokeTarget, { rootId })
        : Promise.resolve(failure),
    cancel: (transferId: string) =>
      isOpaqueId(transferId)
        ? call(SERVICE_CHANNELS.cancel, { transferId })
        : Promise.resolve(failure),
    retryCleanup: () => call(SERVICE_CHANNELS.cleanup),
    startScan: (rootId: string) => scanCall(SERVICE_CHANNELS.scanStart, 'rootId', rootId),
    queryScan: (scanId: string) => scanCall(SERVICE_CHANNELS.scanQuery, 'scanId', scanId),
    cancelScan: (scanId: string) => scanCall(SERVICE_CHANNELS.scanCancel, 'scanId', scanId),
  })
}
