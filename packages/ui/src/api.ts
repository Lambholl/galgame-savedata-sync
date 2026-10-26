import type {
  BatchState,
  DirectoryListing,
  DirectoryReference,
  DirectorySelectionResult,
  FileMetadata,
  LibraryConfig,
  LibraryGame,
  LibraryPeer,
  OperationResult,
} from '@savedata-sync/shared'

/** 界面只消费公开元数据；字节、路径和原生句柄留在平台适配器。 */
export interface UiSnapshot {
  readonly warning: string | null
  readonly config: LibraryConfig
  readonly peers: readonly LibraryPeer[]
  readonly roots: readonly DirectoryReference[]
  readonly grantedRoots: readonly string[]
  readonly service: { readonly addresses: readonly string[]; readonly isRunning: boolean } | null
  readonly tasks: readonly UiTask[]
}
export interface UiTask {
  readonly id: string
  readonly title: string
  readonly local: BatchState | null
  readonly remote: BatchState | null
  readonly upload: boolean
  readonly names: Readonly<Record<string, string>>
}
export interface UiTransfer {
  readonly deviceId: string
  readonly upload: boolean
  readonly sourceRootId: string
  readonly targetRootId: string
  readonly targetParentId: string | null
  readonly files: readonly FileMetadata[]
  readonly names: Readonly<Record<string, string>>
  readonly title: string
}
/** 所有异步失败抛 Error 给统一提示；开始任务由原生持有，切页不取消。 */
export interface UiAdapter {
  readonly platform: 'windows' | 'android'
  read(): Promise<UiSnapshot>
  saveGames(games: readonly LibraryGame[]): Promise<void>
  chooseDirectory(receive: boolean): Promise<DirectorySelectionResult>
  revokeReceive(rootId: string): Promise<void>
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
  start(transfer: UiTransfer): Promise<void>
  cancel(id: string): Promise<void>
  cleanup(): Promise<void>
  service(start: boolean, port: number): Promise<void>
}
export function unwrap<T>(result: OperationResult<T>): T {
  if (result.status === 'error') {
    throw new Error(result.error.message)
  }
  return result.value
}
export function displayBytes(value: number | null): string {
  return value === null
    ? '未知'
    : value < 1024
      ? `${value} B`
      : value < 1048576
        ? `${(value / 1024).toFixed(1)} KiB`
        : `${(value / 1048576).toFixed(1)} MiB`
}
export function displayTime(value: number | null): string {
  return value === null
    ? '时间未知'
    : new Date(value).toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
}
export function taskIsActive(task: UiTask): boolean {
  return (
    !task.local ||
    task.local.status === 'running' ||
    task.remote?.status === 'running' ||
    (task.upload && task.local.status === 'sent' && !task.remote)
  )
}
