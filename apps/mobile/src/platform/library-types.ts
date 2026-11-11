import type {
  DirectoryListing,
  DirectoryReference,
  DirectorySelectionResult,
  LibraryConfig,
  LibraryGame,
  LibraryPeer,
  OperationResult,
  TransferRequest,
  TransferTask,
} from '@savedata-sync/shared'

/** 游戏库、设备、目录和任务的快照。 */
export interface MobileSnapshot {
  readonly warning: string | null
  readonly config: LibraryConfig
  /** 本机系统名称；读取失败时为 null。 */
  readonly deviceName: string | null
  readonly peers: readonly LibraryPeer[]
  readonly roots: readonly DirectoryReference[]
  readonly tasks: readonly TransferTask[]
}

/** 移动游戏库接口。directory 以外的方法失败时 reject。 */
export interface MobileLibraryAdapter {
  /** 读取快照，并按需与已连接的设备交换目录表。 */
  read(): Promise<MobileSnapshot>
  /** 用 games 替换全部本机游戏。 */
  saveGames(games: readonly LibraryGame[]): Promise<void>
  /** 打开系统目录选择器并登记所选目录。 */
  chooseDirectory(): Promise<DirectorySelectionResult>
  /** 连接 address 并保存设备；resolve 对方的设备名（已保存过的用保存的名称）。 */
  connect(address: string, expectedDeviceId?: string): Promise<string>
  /**
   * 依次用 candidates 里的地址连接 expectedDeviceId 那台设备，第一个连上且设备 ID 一致的地址保存为该设备的地址，resolve 对方的设备名。
   * 某个地址连不上或连到别的设备时换下一个；全部失败时 reject 最后一个地址的错误。
   * 已有连接时 reject `busy`，不再尝试后面的地址。
   */
  connectCandidates(candidates: readonly string[], expectedDeviceId: string): Promise<string>
  /**
   * 管理一台已保存的设备：disconnect 断开，allow 用保存的地址重新连接，forget 断开并删除设备和关联，
   * rename 修改名称和地址；name 和 address 只用于 rename，已连接时不能改地址。
   */
  device(
    id: string,
    action: 'disconnect' | 'allow' | 'forget' | 'rename',
    name?: string,
    address?: string,
  ): Promise<void>
  /** 列出目录的一层；deviceId 为 null 时读本机。失败以错误结果返回。 */
  directory(
    deviceId: string | null,
    rootId: string,
    parentId: string | null,
  ): Promise<OperationResult<DirectoryListing>>
  /** 核对项目关联、申请通知权限后开始一次批量传输。 */
  start(transfer: TransferRequest): Promise<void>
  /** 取消一次批量传输。 */
  cancel(id: string): Promise<void>
  /** 重试失败的缓存清理；还有没清理完的文件时 reject。 */
  cleanup(): Promise<void>
}
