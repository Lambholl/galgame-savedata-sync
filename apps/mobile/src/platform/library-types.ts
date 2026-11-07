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

/** 移动页面读取的公开状态；原生句柄、授权和文件内容由平台持有。 */
export interface MobileSnapshot {
  readonly warning: string | null
  readonly config: LibraryConfig
  /** 本机系统名称；读取失败时为 null，界面留空。 */
  readonly deviceName: string | null
  readonly peers: readonly LibraryPeer[]
  readonly roots: readonly DirectoryReference[]
  readonly tasks: readonly TransferTask[]
}

/** 移动游戏库接口：失败抛 Error，目录访问用 OperationResult；原生任务不随页面销毁。 */
export interface MobileLibraryAdapter {
  read(): Promise<MobileSnapshot>
  saveGames(games: readonly LibraryGame[]): Promise<void>
  chooseDirectory(): Promise<DirectorySelectionResult>
  connect(address: string, expectedDeviceId?: string): Promise<void>
  /**
   * 依次用 candidates 里的地址连接 expectedDeviceId 那台设备，第一个连上且设备 ID 一致的地址保存为该设备的地址。
   * 某个地址连不上或连到别的设备时换下一个；全部失败时 reject 最后一个地址的错误。
   * 已有连接时 reject `busy`，不再尝试后面的地址。
   */
  connectCandidates(candidates: readonly string[], expectedDeviceId: string): Promise<void>
  device(
    id: string,
    action: 'disconnect' | 'allow' | 'forget' | 'rename',
    name?: string,
    address?: string,
  ): Promise<void>
  directory(
    deviceId: string | null,
    rootId: string,
    parentId: string | null,
  ): Promise<OperationResult<DirectoryListing>>
  start(transfer: TransferRequest): Promise<void>
  cancel(id: string): Promise<void>
  cleanup(): Promise<void>
}
