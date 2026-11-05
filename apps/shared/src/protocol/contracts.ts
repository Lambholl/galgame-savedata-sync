/** 协议版本。部署后不兼容的变更要用新版本。 */
export const PROTOCOL_VERSION = 1

/** 能力状态。未知不能当作支持；声明支持后调用仍可能失败。 */
export type CapabilityState = 'supported' | 'unsupported' | 'unknown'

/** 条目操作能力，由当前平台或提供者给出，不代表已取得执行授权。 */
export interface EntryCapabilities {
  readonly canRead: CapabilityState
  readonly canList: CapabilityState
  readonly canCreate: CapabilityState
  readonly canRename: CapabilityState
  readonly canDelete: CapabilityState
}

/** 设备公开的协议能力；文件内容始终在平台原生流中处理。 */
export interface DeviceCapabilities {
  readonly canListRoots: CapabilityState
  readonly canReadFiles: CapabilityState
  readonly canReceiveFiles: CapabilityState
  readonly canQueryTransfers: CapabilityState
  readonly canCancelTransfers: CapabilityState
}

/** 设备描述：这次安装的稳定身份，连接地址另存；不含本机路径或 content URI。 */
export interface DeviceDescriptor {
  readonly protocolVersion: typeof PROTOCOL_VERSION
  readonly deviceId: string
  readonly displayName: string
  readonly platform: 'windows' | 'android'
  readonly capabilities: DeviceCapabilities
}

/** 本地根目录的公开引用。unverified 时使用前要重新检查授权，不能显示为空目录。 */
export interface DirectoryReference {
  readonly rootId: string
  readonly deviceId: string
  readonly displayName: string
  readonly authorization: 'granted' | 'expired' | 'unavailable' | 'unverified'
  /** 展示用完整路径或文档提供者地址，不作为文件操作参数。 */
  readonly displayPath?: string
  /** 提供者能确定的父目录名称，用作添加游戏时的默认名称。 */
  readonly parentName?: string
}

/** 条目引用，只在所属根目录内有效；适配器负责解析和防止越界。 */
export interface EntryReference {
  readonly rootId: string
  readonly entryId: string
}

/** parentId 为 null 表示根层；modifiedAt 为条目自身的 Unix 毫秒或未知 null。 */
interface EntryMetadataBase extends EntryReference {
  readonly parentId: string | null
  readonly name: string
  readonly modifiedAt: number | null
  readonly capabilities: EntryCapabilities
}

/** 文件大小使用安全整数的字节数；未知为 null，空文件为 0。 */
export interface FileMetadata extends EntryMetadataBase {
  readonly kind: 'file'
  readonly sizeBytes: number | null
}

/** 文件夹不递归汇总大小，sizeBytes 必须为 null。 */
export interface DirectoryMetadata extends EntryMetadataBase {
  readonly kind: 'directory'
  readonly sizeBytes: null
}

/** 当前条目快照，不保存为以后比较的基线，也不按修改日期选择方向。 */
export type EntryMetadata = FileMetadata | DirectoryMetadata

/** 一层目录的列表；成功的空数组表示真实空目录，observedAt 是读取时的 Unix 毫秒。 */
export interface DirectoryListing {
  readonly rootId: string
  readonly parentId: string | null
  readonly observedAt: number
  readonly entries: readonly EntryMetadata[]
}

/** 跨 HTTP 和本地桥的稳定错误码；未知属性用 null，不算错误。 */
export type OperationErrorCode =
  | 'invalid-request'
  | 'protocol-mismatch'
  | 'session-mismatch'
  | 'task-conflict'
  | 'plan-expired'
  | 'invalid-archive'
  | 'resource-limit'
  | 'busy'
  | 'timeout'
  | 'permission-denied'
  | 'authorization-expired'
  | 'not-found'
  | 'not-readable'
  | 'unsupported-operation'
  | 'name-conflict'
  | 'path-outside-root'
  | 'source-changed'
  | 'checksum-mismatch'
  | 'network-failure'
  | 'insufficient-space'
  | 'io-failure'
  | 'cleanup-failed'
  | 'result-unknown'

/** 出错的一端；phone 表示移动端，平板也用这个值。取值已随协议发布，协议变化前不改名。 */
export type ErrorDevice = 'phone' | 'pc'

/**
 * 操作错误。message 必须脱敏；canRetry 只表示用户可以在核实当前状态后发起新操作，不能自动重做。
 * device 只在确定是哪一端访问文件或目录失败时才有。
 */
export type OperationError = (
  | {
      readonly code: Exclude<OperationErrorCode, 'result-unknown' | 'session-mismatch'>
      readonly message: string
      readonly canRetry: boolean
    }
  | {
      readonly code: 'result-unknown'
      readonly message: string
      readonly canRetry: false
    }
  | {
      readonly code: 'session-mismatch'
      readonly message: string
      readonly canRetry: false
    }
) & { readonly device?: ErrorDevice }

/** 操作结果，成功值和错误互斥；无副作用的读取和本地桥用它，不能用空值掩盖失败。 */
export type OperationResult<TValue> =
  | { readonly status: 'success'; readonly value: TValue }
  | { readonly status: 'error'; readonly error: OperationError }

/** 目录选择结果。取消系统选择器不表示目录失效，已有目录引用保留。 */
export type DirectorySelectionResult =
  | { readonly status: 'selected'; readonly directory: DirectoryReference }
  | { readonly status: 'cancelled' }
  | { readonly status: 'error'; readonly error: OperationError }

/** 传输方向，由用户为本次操作明确选择，与历史方向、日期和文件数量无关。 */
export type TransferDirection = 'windows-to-android' | 'android-to-windows'

/** 本机已选择的目录描述列表，不含平台路径。 */
export type RootsResponse = OperationResult<readonly DirectoryReference[]>

/** 列目录的响应。失败时用 error，不能返回成功的空列表。 */
export type DirectoryResponse = OperationResult<DirectoryListing>
