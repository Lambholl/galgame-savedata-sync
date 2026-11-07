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
import type { DesktopDiscoveryState } from '../../../bridge/service-bridge.ts'
import type { DesktopCopySummary, DesktopRestoreSummary } from '../../../bridge/sync-bridge.ts'

/** 设备页显示的本机服务状态。 */
export interface DesktopServiceView {
  /** 本机稳定设备 ID，写进连接二维码。 */
  readonly deviceId: string
  /** 设置里保存的监听端口；服务停止时在设备页修改。 */
  readonly port: number
  /** 正在监听时的端口和开始时间；服务停止时为 null。 */
  readonly listener: {
    readonly port: number
    /** 开始监听的时间（Unix 毫秒）。 */
    readonly startedAt: number
  } | null
  /** 本机 IPv4 地址，按推荐顺序排列，最多 8 个；服务启动后还在读取时为 null，服务停止或读不到网卡时为空数组。 */
  readonly ipv4Addresses: readonly string[] | null
  readonly discovery: DesktopDiscoveryState
}

/** 界面读取的快照，只含公开元数据；字节、路径和原生句柄留在平台适配器。 */
export interface DesktopSnapshot {
  readonly warning: string | null
  readonly config: LibraryConfig
  /** 本机系统名称；读取失败时为 null，界面留空。 */
  readonly deviceName: string | null
  readonly peers: readonly LibraryPeer[]
  readonly roots: readonly DirectoryReference[]
  readonly service: DesktopServiceView | null
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
