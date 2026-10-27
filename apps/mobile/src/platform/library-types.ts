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

/** 移动页面读取的公开状态；原生句柄、授权与文件内容由平台持有。 */
export interface MobileSnapshot {
  readonly warning: string | null
  readonly config: LibraryConfig
  readonly peers: readonly LibraryPeer[]
  readonly roots: readonly DirectoryReference[]
  readonly tasks: readonly TransferTask[]
}

/** Android 能力；失败抛 Error，目录访问沿用 OperationResult。原生任务不随页面销毁。 */
export interface MobileLibraryAdapter {
  read(): Promise<MobileSnapshot>
  saveGames(games: readonly LibraryGame[]): Promise<void>
  chooseDirectory(): Promise<DirectorySelectionResult>
  connect(address: string, expectedDeviceId?: string): Promise<void>
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
