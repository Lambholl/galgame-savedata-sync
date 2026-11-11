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
  /** 本机稳定设备 ID。 */
  readonly deviceId: string
  /** 设置里保存的监听端口。 */
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

/** 游戏库、服务和任务的快照。 */
export interface DesktopSnapshot {
  readonly warning: string | null
  readonly config: LibraryConfig
  /** 本机系统名称；读取失败时为 null。 */
  readonly deviceName: string | null
  readonly peers: readonly LibraryPeer[]
  readonly roots: readonly DirectoryReference[]
  readonly service: DesktopServiceView | null
  readonly tasks: readonly TransferTask[]
  readonly copies: readonly DesktopCopySummary[]
  readonly restores: readonly DesktopRestoreSummary[]
  readonly hasActiveOperation: boolean
}
/** 桌面游戏库接口。directory 以外的方法失败时 reject。 */
export interface DesktopLibraryAdapter {
  /** 读取快照；任务的方向标题按 t 的语言生成。 */
  read(t: Translate): Promise<DesktopSnapshot>
  /** 用 games 替换全部本机游戏。 */
  saveGames(games: readonly LibraryGame[]): Promise<void>
  /** 打开系统目录选择器并登记所选目录。 */
  chooseDirectory(): Promise<DirectorySelectionResult>
  /** 断开、重命名或忘记一台设备；rename 时 name 是新名称。 */
  device(id: string, action: 'disconnect' | 'forget' | 'rename', name?: string): Promise<void>
  /** 列出目录的一层；deviceId 为 null 时读本机。失败以错误结果返回。 */
  directory(
    deviceId: string | null,
    rootId: string,
    parentId: string | null,
  ): Promise<OperationResult<DirectoryListing>>
  /** 取消一次批量传输。 */
  cancel(id: string): Promise<void>
  /** 重试失败的缓存清理。 */
  cleanup(): Promise<void>
  /** shouldStart 为 true 时在 port 启动服务，否则停止服务。 */
  service(shouldStart: boolean, port: number): Promise<void>
  /** 换一个随机端口，返回新端口。 */
  randomizePort(): Promise<number>
}
