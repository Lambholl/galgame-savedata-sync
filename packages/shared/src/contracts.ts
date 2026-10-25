/** M-001 的线协议版本；不兼容的字段或语义变化必须使用新版本。 */
export const PROTOCOL_VERSION = 1

/** 能力未知不能当作支持；即使声明支持，调用仍可能失败。 */
export type CapabilityState = 'supported' | 'unsupported' | 'unknown'

/** 条目操作能力由当前平台/提供者给出，不代表已经取得执行授权。 */
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

/** 安装内稳定身份；连接地址独立保存，协议不暴露本机路径或 content URI。 */
export interface DeviceDescriptor {
  readonly protocolVersion: typeof PROTOCOL_VERSION
  readonly deviceId: string
  readonly displayName: string
  readonly platform: 'windows' | 'android'
  readonly capabilities: DeviceCapabilities
}

/** 本地根目录的公开引用；unverified 要求使用前重查授权，不能显示为空目录。 */
export interface DirectoryReference {
  readonly rootId: string
  readonly deviceId: string
  readonly displayName: string
  readonly authorization: 'granted' | 'expired' | 'unavailable' | 'unverified'
}

/** 引用仅在所属根目录内有效；适配器负责解析及防止越界，不拼装主机路径。 */
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

/** 当前条目快照；不保存为历史共同基线，不按修改日期选择方向。 */
export type EntryMetadata = FileMetadata | DirectoryMetadata

/** 仅列当前层；成功空数组表示真实空目录，observedAt 是读取时的 Unix 毫秒。 */
export interface DirectoryListing {
  readonly rootId: string
  readonly parentId: string | null
  readonly observedAt: number
  readonly entries: readonly EntryMetadata[]
}

/** 跨 HTTP/本地桥的稳定错误码；未知属性用 null，不作为错误。 */
export type OperationErrorCode =
  | 'invalid-request'
  | 'protocol-mismatch'
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

/** 信息须脱敏；canRetry 只允许核实当前状态后由用户发起新操作，不授权自动重放。 */
export type OperationError =
  | {
      readonly code: Exclude<OperationErrorCode, 'result-unknown'>
      readonly message: string
      readonly canRetry: boolean
    }
  | {
      readonly code: 'result-unknown'
      readonly message: string
      readonly canRetry: false
    }

/** 成功值和错误互斥；无副作用的读取/本地桥使用此包络，不能用空值掩盖失败。 */
export type OperationResult<TValue> =
  | { readonly status: 'success'; readonly value: TValue }
  | { readonly status: 'error'; readonly error: OperationError }

/** 取消系统选择器不表示目录失效，也不清除既有目录引用。 */
export type DirectorySelectionResult =
  | { readonly status: 'selected'; readonly directory: DirectoryReference }
  | { readonly status: 'cancelled' }
  | { readonly status: 'error'; readonly error: OperationError }

/** 用户为本次操作明确选择的方向；与历史方向、日期及文件数量无关。 */
export type TransferDirection = 'windows-to-android' | 'android-to-windows'

/** 校验与发布尚未成功，不能凭字节进度完成就报告任务成功。 */
export type TransferStage = 'preparing' | 'transferring' | 'verifying' | 'publishing'

/** 本次会话身份；字节数为已传内容而非目录汇总，总量未知为 null。 */
interface TransferIdentity {
  readonly transferId: string
  readonly direction: TransferDirection
}

/** 进度仅供展示；总量未知时不计算百分比，订阅者负责释放本地桥监听。 */
export interface TransferProgress extends TransferIdentity {
  readonly status: 'running'
  readonly stage: TransferStage
  readonly bytesTransferred: number
  readonly totalBytes: number | null
}

/** 成功意味着目标发布并校验完毕；sha256 是本次实际内容的小写 64 位十六进制。 */
export interface TransferReceipt extends TransferIdentity {
  readonly status: 'succeeded'
  readonly bytesTransferred: number
  readonly sha256: string
  readonly entry: FileMetadata
}

/** 失败/取消可能留下本次新建条目；null 仅表示未报告残留，不保证原子回滚。 */
export type TransferResult =
  | TransferReceipt
  | (TransferIdentity & {
      readonly status: 'failed'
      readonly error: OperationError & {
        readonly code: Exclude<OperationErrorCode, 'result-unknown'>
      }
      readonly residualEntry: EntryReference | null
    })
  | (TransferIdentity & {
      readonly status: 'cancelled'
      readonly residualEntry: EntryReference | null
    })
  | (TransferIdentity & {
      readonly status: 'unknown'
      readonly error: OperationError & { readonly code: 'result-unknown' }
    })

/** 查询结果为会话内观察；unknown 不等于未写入，需重读目标，不恢复旧任务。 */
export type TransferState = TransferProgress | TransferResult

/** M-001 只创建新文件；name 是单文件名，哈希仅用于本次校验，长度未知为 null。 */
export interface CreateFileRequest {
  readonly rootId: string
  readonly parentId: string | null
  readonly transferId: string
  readonly name: string
  readonly expectedSizeBytes: number | null
  readonly expectedSha256: string
}

/** JSON 只读端点均使用互斥包络；文件字节下载本身不使用 JSON 包络。 */
export type DeviceResponse = OperationResult<DeviceDescriptor>

/** 只包含本机已选择的目录描述，不公开平台路径。 */
export type RootsResponse = OperationResult<readonly DirectoryReference[]>

/** 列目录失败使用 error，不能返回成功的空列表。 */
export type DirectoryResponse = OperationResult<DirectoryListing>

/** PUT 仅在发布校验后返回成功回执；失败任务的实际状态可另外查询。 */
export type CreateFileResponse = OperationResult<TransferReceipt>

/** 查询成功只表示取得状态；value.status 才决定文件操作是否成功。 */
export type TransferResponse = OperationResult<TransferState>
