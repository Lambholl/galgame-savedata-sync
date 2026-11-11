import { isOpaqueId } from '../protocol/protocol.ts'

/** 写入标记：一次目标目录写入开始时保存，结束时删除。id 是计划 ID。 */
export interface InterruptedWrite {
  readonly id: string
  readonly projectId: string
  readonly rootId: string
  /** 写入前的备份；关闭备份或目标原本没有文件时为 null。 */
  readonly backupId: string | null
  /** 开始写入的时间，毫秒时间戳。 */
  readonly startedAt: number
}

/** 一次最多读取的写入标记数。 */
export const MAX_INTERRUPTED_WRITES = 16

/** 校验写入标记。 */
export function isInterruptedWrite(value: unknown): value is InterruptedWrite {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const item = value as Record<string, unknown>
  return (
    Object.keys(item).length === 5 &&
    [item.id, item.projectId, item.rootId].every(isOpaqueId) &&
    (item.backupId === null || isOpaqueId(item.backupId)) &&
    typeof item.startedAt === 'number' &&
    Number.isSafeInteger(item.startedAt)
  )
}

/** 校验写入标记列表：最多 MAX_INTERRUPTED_WRITES 条。 */
export function isInterruptedWriteList(value: unknown): value is readonly InterruptedWrite[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_INTERRUPTED_WRITES &&
    value.every(isInterruptedWrite)
  )
}
