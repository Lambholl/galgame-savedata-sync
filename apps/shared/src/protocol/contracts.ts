/** 协议版本。不兼容的变更使用新版本号。 */
export const PROTOCOL_VERSION = 1

/** 能力状态。supported 表示平台声明支持，调用仍可能失败。 */
export type CapabilityState = 'supported' | 'unsupported' | 'unknown'

/** 条目操作能力，由当前平台或提供者声明。 */
export interface EntryCapabilities {
  readonly canRead: CapabilityState
  readonly canList: CapabilityState
  readonly canCreate: CapabilityState
  readonly canRename: CapabilityState
  readonly canDelete: CapabilityState
}

/** 设备公开的协议能力。 */
export interface DeviceCapabilities {
  readonly canListRoots: CapabilityState
  readonly canReadFiles: CapabilityState
  readonly canReceiveFiles: CapabilityState
  readonly canQueryTransfers: CapabilityState
  readonly canCancelTransfers: CapabilityState
}

/** 设备描述：这次安装的稳定身份和显示信息。 */
export interface DeviceDescriptor {
  readonly protocolVersion: typeof PROTOCOL_VERSION
  readonly deviceId: string
  readonly displayName: string
  readonly platform: 'windows' | 'android'
  readonly capabilities: DeviceCapabilities
}

/** 本地根目录的公开引用。authorization 为 unverified 时，授权状态还没检查。 */
export interface DirectoryReference {
  readonly rootId: string
  readonly deviceId: string
  readonly displayName: string
  readonly authorization: 'granted' | 'expired' | 'unavailable' | 'unverified'
  /** 展示用的完整路径或文档提供者地址。 */
  readonly displayPath?: string
  /** 提供者能确定的父目录名称，用作添加游戏时的默认名称。 */
  readonly parentName?: string
}

/** 条目引用，只在所属根目录内有效。 */
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

/** 条目在读取时的元数据快照。 */
export type EntryMetadata = FileMetadata | DirectoryMetadata

/** 一层目录的列表；成功的空数组表示真实空目录，observedAt 是读取时的 Unix 毫秒。 */
export interface DirectoryListing {
  readonly rootId: string
  readonly parentId: string | null
  readonly observedAt: number
  readonly entries: readonly EntryMetadata[]
}

/** HTTP 和本地桥共用的稳定错误码。 */
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
 * 操作错误。message 已脱敏；canRetry 表示用户核实当前状态后可以重新发起操作。
 * device 在确定是哪一端访问文件或目录失败时才有。
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

/** 操作结果，成功值和错误互斥。 */
export type OperationResult<TValue> =
  | { readonly status: 'success'; readonly value: TValue }
  | { readonly status: 'error'; readonly error: OperationError }

/** 目录选择结果：selected、cancelled 或 error。 */
export type DirectorySelectionResult =
  | { readonly status: 'selected'; readonly directory: DirectoryReference }
  | { readonly status: 'cancelled' }
  | { readonly status: 'error'; readonly error: OperationError }

/** 传输方向。 */
export type TransferDirection = 'windows-to-android' | 'android-to-windows'

/** 本机已选择的目录引用列表。 */
export type RootsResponse = OperationResult<readonly DirectoryReference[]>

/** 列目录的响应。 */
export type DirectoryResponse = OperationResult<DirectoryListing>
