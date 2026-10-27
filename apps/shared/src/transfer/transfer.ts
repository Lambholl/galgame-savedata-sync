import type { BatchState } from '../protocol/batch-contracts.ts'
import type { DirectoryListing, FileMetadata } from '../protocol/contracts.ts'

/** 两端传输任务的状态；upload 表示手机发送到电脑，names 按源 entryId 指定目标名。 */
export interface TransferTask {
  readonly id: string
  readonly title: string
  readonly local: BatchState | null
  readonly remote: BatchState | null
  readonly upload: boolean
  readonly names: Readonly<Record<string, string>>
}

/** 发起当前层选中文件的传输；空目标 parentId 表示根目录，未指定的名称沿用源名称。 */
export interface TransferRequest {
  readonly deviceId: string
  readonly upload: boolean
  readonly sourceRootId: string
  readonly targetRootId: string
  readonly targetParentId: string | null
  readonly files: readonly FileMetadata[]
  readonly names: Readonly<Record<string, string>>
  readonly title: string
}

/** 已读取的当前目录与所选文件；parentId 为 null 时位于根目录。 */
export interface DirectoryLocation {
  readonly rootId: string
  readonly parentId: string | null
  readonly listing: DirectoryListing
  readonly files: readonly FileMetadata[]
}

/** 本地尚无结果、任一端运行中，或发送完成但尚未收到对端结果时，任务仍在进行。 */
export function taskIsActive(task: TransferTask): boolean {
  return (
    !task.local ||
    task.local.status === 'running' ||
    task.remote?.status === 'running' ||
    (task.upload && task.local.status === 'sent' && !task.remote)
  )
}
