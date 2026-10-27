import { isPortableFileName } from '../protocol/protocol.ts'
import type { DirectoryLocation } from './transfer.ts'

/** 按预检顺序返回的首个问题；由各端选择提示文案。 */
export type TransferProblem =
  | 'peer-disconnected'
  | 'directories-missing'
  | 'files-empty'
  | 'invalid-name'
  | 'duplicate-names'
  | 'target-exists'
  | 'receive-not-authorized'

/** 当前预览所需数据；不需要接收授权的传输应传入 isReceiveAuthorized: true。 */
export interface TransferSelection {
  readonly isPeerConnected: boolean
  readonly source: DirectoryLocation | null
  readonly target: DirectoryLocation | null
  readonly names: Readonly<Record<string, string>>
  readonly isReceiveAuthorized: boolean
}

/**
 * 检查当前选择，返回首个问题或 null；不修改数据、不抛业务错误。
 * 文件名沿用协议校验，批内重名与目标冲突均忽略大小写；调用端仍负责实际传输校验。
 */
export function validateTransferSelection({
  isPeerConnected,
  source,
  target,
  names,
  isReceiveAuthorized,
}: TransferSelection): TransferProblem | null {
  if (!isPeerConnected) {
    return 'peer-disconnected'
  }
  if (!source || !target) {
    return 'directories-missing'
  }
  if (!source.files.length) {
    return 'files-empty'
  }
  const targetNames = source.files.map((file) => names[file.entryId] ?? file.name)
  if (!targetNames.every(isPortableFileName)) {
    return 'invalid-name'
  }
  if (new Set(targetNames.map((name) => name.toLowerCase())).size !== targetNames.length) {
    return 'duplicate-names'
  }
  if (
    target.listing.entries.some((entry) =>
      targetNames.some((name) => name.toLowerCase() === entry.name.toLowerCase()),
    )
  ) {
    return 'target-exists'
  }
  if (!isReceiveAuthorized) {
    return 'receive-not-authorized'
  }
  return null
}
