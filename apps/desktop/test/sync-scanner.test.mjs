import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { NOMEDIA_NAME, writeCandidateName } from '@savedata-sync/shared'
import { createDirectoryAdapter } from '../src/backend/directory-adapter.ts'
import { WindowsSyncScanner } from '../src/backend/sync-scanner.ts'

test('扫描跳过任意层级的 .nomedia 文件', async (t) => {
  // 和 Android SyncScannerTest 用同一组条目：根目录和子目录各有一个 .nomedia。
  const base = await mkdtemp(join(await realpath(tmpdir()), 'savedata-scanner-test-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'root')
  await mkdir(join(root, 'save'), { recursive: true })
  await writeFile(join(root, NOMEDIA_NAME), '')
  await writeFile(join(root, 'save', NOMEDIA_NAME), '')
  await writeFile(join(root, 'save', 'a.sav'), 'a')

  const adapter = await createDirectoryAdapter(join(base, 'control', 'directories.json'))
  const selected = await adapter.registerDirectory(root)
  assert.equal(selected.status, 'success')
  const scanner = new WindowsSyncScanner(adapter)
  t.after(() => scanner.stop())
  const state = await scanner.wait(scanner.start(selected.value.rootId).scanId)

  assert.equal(state.status, 'succeeded', JSON.stringify(state.error))
  assert.deepEqual(
    state.snapshot.entries.map((entry) => entry.path.join('/')),
    ['save', 'save/a.sav'],
  )
})

test('扫描跳过写入中断留下的候选文件，其余文件照常列出', async (t) => {
  // Windows 的 TEMP 可能含 8.3 别名，夹具与适配器须使用一致的真实路径。
  const base = await mkdtemp(join(await realpath(tmpdir()), 'savedata-scanner-test-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'root')
  await mkdir(join(root, 'save'), { recursive: true })
  await writeFile(join(root, 'save', 'a.sav'), 'a')
  await writeFile(join(root, 'save', writeCandidateName('copy', randomUUID())), 'partial')
  await writeFile(join(root, writeCandidateName('new', randomUUID())), 'partial')

  const adapter = await createDirectoryAdapter(join(base, 'control', 'directories.json'))
  const selected = await adapter.registerDirectory(root)
  assert.equal(selected.status, 'success')
  const scanner = new WindowsSyncScanner(adapter)
  t.after(() => scanner.stop())
  const state = await scanner.wait(scanner.start(selected.value.rootId).scanId)

  assert.equal(state.status, 'succeeded', JSON.stringify(state.error))
  assert.deepEqual(
    state.snapshot.entries.map((entry) => entry.path.join('/')),
    ['save', 'save/a.sav'],
  )
})
