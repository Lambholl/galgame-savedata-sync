import { isOpaqueId } from '../protocol/protocol.ts'

/**
 * 写入标记：开始写目标目录前落盘，写入结束时删除。上一个进程留下的标记说明那次写入没有走到结束，
 * 目标文件可能不完整。文件名与 id 相同，id 取计划 ID。
 */
export interface InterruptedWrite {
  readonly id: string
  readonly projectId: string
  readonly rootId: string
  /** 写入前的备份；关闭备份或目标原本没有文件时为 null。 */
  readonly backupId: string | null
  /** 开始写入的时间，毫秒时间戳。 */
  readonly startedAt: number
}

/** 一次最多读取的标记数；每次写入结束都会删除自己的标记，正常不会累积。 */
export const MAX_INTERRUPTED_WRITES = 16

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

export function isInterruptedWriteList(value: unknown): value is readonly InterruptedWrite[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_INTERRUPTED_WRITES &&
    value.every(isInterruptedWrite)
  )
}
