import type {
  DirectoryListing,
  DirectoryReference,
  DirectorySelectionResult,
  LibraryConfig,
  LibraryGame,
  LibraryPeer,
  OperationResult,
  TransferTask,
} from '@savedata-sync/shared'

/** 界面只消费公开元数据；字节、路径和原生句柄留在平台适配器。 */
export interface DesktopSnapshot {
  readonly warning: string | null
  readonly config: LibraryConfig
  readonly peers: readonly LibraryPeer[]
  readonly roots: readonly DirectoryReference[]
  readonly service: {
    readonly addresses: readonly string[]
    readonly isRunning: boolean
    readonly port: number
  } | null
  readonly tasks: readonly TransferTask[]
}
/** 配置、设备和任务操作失败时抛 Error；目录结果由调用端解包，切页保留原生任务。 */
export interface DesktopLibraryAdapter {
  read(): Promise<DesktopSnapshot>
  saveGames(games: readonly LibraryGame[]): Promise<void>
  chooseDirectory(): Promise<DirectorySelectionResult>
  device(id: string, action: 'disconnect' | 'forget' | 'rename', name?: string): Promise<void>
  directory(
    deviceId: string | null,
    rootId: string,
    parentId: string | null,
  ): Promise<OperationResult<DirectoryListing>>
  cancel(id: string): Promise<void>
  cleanup(): Promise<void>
  service(shouldStart: boolean, port: number): Promise<void>
  randomizePort(): Promise<number>
}
