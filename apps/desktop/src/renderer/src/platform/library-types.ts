import type {
  DirectoryListing,
  DirectoryReference,
  DirectorySelectionResult,
  LibraryConfig,
  LibraryGame,
  LibraryPeer,
  OperationResult,
  TransferTask,
  Translate,
} from '@savedata-sync/shared'
import type { DesktopCopySummary, DesktopRestoreSummary } from '../../../bridge/sync-bridge.ts'

/** 界面读取的快照，只含公开元数据；字节、路径和原生句柄留在平台适配器。 */
export interface DesktopSnapshot {
  readonly warning: string | null
  readonly config: LibraryConfig
  /** 本机系统名称；读取失败时为 null，界面留空。 */
  readonly deviceName: string | null
  readonly peers: readonly LibraryPeer[]
  readonly roots: readonly DirectoryReference[]
  readonly service: {
    readonly addresses: readonly string[]
    readonly isRunning: boolean
    readonly port: number
  } | null
  readonly tasks: readonly TransferTask[]
  readonly copies: readonly DesktopCopySummary[]
  readonly restores: readonly DesktopRestoreSummary[]
  readonly hasActiveOperation: boolean
}
/** 桌面游戏库接口：配置、设备和任务操作失败时抛 Error，目录结果由调用端解包；切页不影响主进程里的任务。 */
export interface DesktopLibraryAdapter {
  /** 按当前界面语言生成任务的方向标题。 */
  read(t: Translate): Promise<DesktopSnapshot>
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
