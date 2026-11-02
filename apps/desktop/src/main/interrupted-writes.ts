import { mkdir, open, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isInterruptedWrite, MAX_INTERRUPTED_WRITES } from '@savedata-sync/shared'
import type { InterruptedWrite, SyncPlan } from '@savedata-sync/shared'

/**
 * 写入标记：开始写目标目录前落盘，写入结束时删除。上一个进程留下的标记说明那次写入被中断。
 * 标记只放应用私有目录，不含路径和文件内容。
 */
export class InterruptedWriteStore {
  private readonly directory: string
  private readonly active = new Set<string>()
  constructor(privateDirectory: string) {
    this.directory = join(privateDirectory, 'interrupted-writes')
  }
  private file(id: string): string {
    return join(this.directory, `${id}.json`)
  }
  /** 落盘失败时 reject，调用者不再写目标，避免写入中断后没有提示。 */
  async begin(plan: SyncPlan, backupId: string | null): Promise<void> {
    const write: InterruptedWrite = {
      id: plan.planId,
      projectId: plan.projectId,
      rootId: plan.target.rootId,
      backupId,
      startedAt: Date.now(),
    }
    await mkdir(this.directory, { recursive: true })
    this.active.add(write.id)
    const handle = await open(this.file(write.id), 'wx', 0o600)
    try {
      await handle.writeFile(JSON.stringify(write), 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
  /** 写入结束时调用，不会 reject；删除失败只会多提示一次，不影响已核实的写入结果。 */
  async end(id: string): Promise<void> {
    await rm(this.file(id), { force: true }).catch(() => undefined)
    this.active.delete(id)
  }
  /** 上个进程留下的标记，最早的在前；读不懂的文件直接删除。 */
  async list(): Promise<readonly InterruptedWrite[]> {
    const names = await readdir(this.directory).catch(() => [])
    const writes: InterruptedWrite[] = []
    for (const name of names) {
      if (this.active.has(name.replace(/\.json$/, ''))) {
        continue
      }
      const path = join(this.directory, name)
      try {
        const value: unknown = JSON.parse(await readFile(path, 'utf8'))
        if (!isInterruptedWrite(value) || name !== `${value.id}.json`) {
          throw new Error('The write marker is invalid.')
        }
        writes.push(value)
      } catch {
        await rm(path, { force: true }).catch(() => undefined)
      }
    }
    return writes.sort((a, b) => a.startedAt - b.startedAt).slice(0, MAX_INTERRUPTED_WRITES)
  }
  async dismiss(id: string): Promise<void> {
    if (!this.active.has(id)) {
      await rm(this.file(id), { force: true })
    }
  }
}
