import { mkdir, open, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isInterruptedWrite, MAX_INTERRUPTED_WRITES } from '@savedata-sync/shared'
import type { InterruptedWrite, SyncPlan } from '@savedata-sync/shared'

/** 写入标记的存储。标记在开始写目标目录前落盘，写入结束时删除；上一个进程留下的标记说明那次写入被中断。 */
export class InterruptedWriteStore {
  private readonly directory: string
  private readonly active = new Set<string>()
  constructor(privateDirectory: string) {
    this.directory = join(privateDirectory, 'interrupted-writes')
  }
  private file(id: string): string {
    return join(this.directory, `${id}.json`)
  }
  /** 为一次写入落盘标记；落盘失败时 reject。 */
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
  /** 删除一次写入的标记；删除失败时忽略，不会 reject。 */
  async end(id: string): Promise<void> {
    await rm(this.file(id), { force: true }).catch(() => undefined)
    this.active.delete(id)
  }
  /** 列出之前的进程留下的标记，最早的在前；无法解析的标记文件会被删除。 */
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
  /** 删除一个之前的进程留下的标记；正在进行的写入的标记保留。 */
  async dismiss(id: string): Promise<void> {
    if (!this.active.has(id)) {
      await rm(this.file(id), { force: true })
    }
  }
}
