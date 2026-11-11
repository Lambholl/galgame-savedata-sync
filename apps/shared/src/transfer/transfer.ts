import type { BatchState } from '../protocol/batch-contracts.ts'
import type { DirectoryListing, FileMetadata } from '../protocol/contracts.ts'

/** 两端传输任务的状态；upload 表示移动端发送到电脑，names 是源 entryId 到目标名的映射。 */
export interface TransferTask {
  readonly id: string
  readonly title: string
  readonly local: BatchState | null
  readonly remote: BatchState | null
  readonly upload: boolean
  readonly names: Readonly<Record<string, string>>
}

/** 传输当前层选中文件的请求；目标 parentId 为 null 表示根目录，没有指定名称的文件沿用源名称。 */
export interface TransferRequest {
  readonly projectId: string
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

/** 判断任务是否仍在进行：本地还没有结果、任一端在运行，或发送完成但还没收到对端结果时返回 true。 */
export function taskIsActive(task: TransferTask): boolean {
  return (
    !task.local ||
    task.local.status === 'running' ||
    task.remote?.status === 'running' ||
    (task.upload && task.local.status === 'sent' && !task.remote)
  )
}
