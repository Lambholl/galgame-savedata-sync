import type {
  BatchManifest,
  BatchState,
  PreparedFile,
  ReceiveBatchRequest,
} from './batch-contracts.ts'
import type { TransferDirection } from './contracts.ts'
import { isBatchManifest, isBatchState, isReceiveBatchRequest } from './batch-validation.ts'

function hasSameManifest(left: BatchManifest, right: BatchManifest): boolean {
  const keys = [
    'protocolVersion',
    'transferId',
    'sourceDeviceId',
    'sourceRootId',
    'totalFileBytes',
  ] as const
  const archiveKeys = ['format', 'compressionLevel', 'sizeBytes', 'tarSizeBytes', 'sha256'] as const
  return (
    keys.every((key) => left[key] === right[key]) &&
    archiveKeys.every((key) => left.archive[key] === right.archive[key]) &&
    left.files.length === right.files.length &&
    left.files.every((file, index) => {
      const other = right.files[index]
      return (
        other !== undefined &&
        (Object.keys(file) as (keyof PreparedFile)[]).every((key) => file[key] === other[key])
      )
    })
  )
}

function matchesReceiverResults(state: BatchState, request: ReceiveBatchRequest): boolean {
  if (state.role !== 'receiver') return false
  const targets = new Map(request.targets.map((target) => [target.fileId, target]))
  const manifest = request.manifest
  if (
    state.fileResults.length > manifest.files.length ||
    (state.status !== 'running' && state.fileResults.length !== manifest.files.length)
  )
    return false
  const seenEntries = new Set<string>()
  for (const result of state.fileResults) {
    const file = manifest.files.find((item) => item.fileId === result.fileId)
    const target = targets.get(result.fileId)
    if (!file || !target) return false
    if (result.status === 'succeeded') {
      if (
        result.bytesWritten !== file.sizeBytes ||
        result.sha256 !== file.sha256 ||
        result.entry.rootId !== request.targetRootId ||
        result.entry.parentId !== target.parentId ||
        result.entry.name !== target.name ||
        seenEntries.has(result.entry.entryId)
      )
        return false
      seenEntries.add(result.entry.entryId)
    } else if ('residualEntries' in result) {
      for (const entry of result.residualEntries) {
        if (entry.rootId !== request.targetRootId || seenEntries.has(entry.entryId)) return false
        seenEntries.add(entry.entryId)
      }
    }
  }
  return true
}

/**
 * 将未知状态与本次清单/目标作纯数据核对，不执行 IO 或保存历史。
 * direction 来自调用者本次任务；sender 不接受 receiver 参数，receiver 必须提供完整请求。
 * 拒绝另一清单、缺失结果、错位目标及哈希/字节不符；不证明文件真实发布。
 * 不校验时间先后、会话或源设备真实性，这些由任务调用者核实。
 */
export function matchesBatchState(
  value: unknown,
  manifest: unknown,
  direction: TransferDirection,
  receiver?: unknown,
): value is BatchState {
  if (
    !isBatchState(value) ||
    !isBatchManifest(manifest) ||
    value.transferId !== manifest.transferId ||
    value.direction !== direction
  )
    return false
  if (value.role === 'sender') {
    if (receiver !== undefined) return false
  } else if (
    !isReceiveBatchRequest(receiver) ||
    !hasSameManifest(manifest, receiver.manifest) ||
    !matchesReceiverResults(value, receiver)
  )
    return false
  if (value.status !== 'running') return true
  const progress = value.progress
  if (
    progress.totalFiles !== manifest.files.length ||
    (progress.totalFileBytes !== null && progress.totalFileBytes !== manifest.totalFileBytes) ||
    (progress.totalArchiveBytes !== null &&
      progress.totalArchiveBytes !== manifest.archive.sizeBytes)
  )
    return false
  return (
    progress.sourceBytesRead <= manifest.totalFileBytes &&
    progress.fileBytesVerified <= manifest.totalFileBytes &&
    progress.fileBytesPublished <= manifest.totalFileBytes &&
    progress.archiveBytesTransferred <= manifest.archive.sizeBytes
  )
}
