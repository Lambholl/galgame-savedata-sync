import { isPortableFileName } from '../protocol/protocol.ts'
import type { DirectoryLocation } from './transfer.ts'

/** 传输选择的预检问题。 */
export type TransferProblem =
  | 'peer-disconnected'
  | 'directories-missing'
  | 'files-empty'
  | 'invalid-name'
  | 'duplicate-names'
  | 'target-exists'
  | 'receive-not-authorized'

/** 预检所需的选择和目标数据；isReceiveAuthorized 为 false 时预检报告缺少接收授权。 */
export interface TransferSelection {
  readonly isPeerConnected: boolean
  readonly source: DirectoryLocation | null
  readonly target: DirectoryLocation | null
  readonly names: Readonly<Record<string, string>>
  readonly isReceiveAuthorized: boolean
}

/**
 * 按固定顺序检查传输选择。
 *
 * @returns 第一个问题；没有问题时返回 null。文件名按协议规则校验，批内重名和目标冲突都忽略大小写。
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
