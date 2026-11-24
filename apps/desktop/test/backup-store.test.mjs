import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import test from 'node:test'
import { BACKUP_SETTINGS_SCHEMA_VERSION, createSyncPlan } from '@savedata-sync/shared'
import { createDirectoryAdapter } from '../src/backend/directory-adapter.ts'
import { createWindowsBackupStore } from '../src/backend/backup-store.ts'
import { WindowsManualBackupRegistry } from '../src/backend/manual-backup-registry.ts'
import { WindowsSyncScanner } from '../src/backend/sync-scanner.ts'
import {
  acquireTargetOperation,
  hasTargetOperation,
  releaseTargetOperation,
} from '../src/backend/target-operation.ts'

const unwrap = (result) => {
  assert.equal(result.status, 'success', JSON.stringify(result))
  return result.value
}

async function setup(t) {
  const temporaryRoot = await realpath(tmpdir())
  const base = await mkdtemp(join(temporaryRoot, 'savedata-backup-test-'))
  const cleanups = []
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) {
      await cleanup()
    }
    const child = relative(temporaryRoot, base)
    assert.ok(
      child &&
        child !== '..' &&
        !child.startsWith(`..${sep}`) &&
        !isAbsolute(child) &&
        base.includes('savedata-backup-test-'),
    )
    await rm(base, { recursive: true, force: true })
  })
  const saveDir = join(base, 'game-save')
  const emptyDir = join(base, 'empty-save')
  const privateDir = join(base, 'private')
  await mkdir(saveDir)
  await mkdir(emptyDir)
  await mkdir(privateDir)
  await writeFile(join(saveDir, 'slot1.sav'), Buffer.from('manual backup content 1'))
  const adapter = await createDirectoryAdapter(join(privateDir, 'directories.json'))
  const saveRoot = unwrap(await adapter.registerDirectory(saveDir))
  const emptyRoot = unwrap(await adapter.registerDirectory(emptyDir))
  const backups = await createWindowsBackupStore(
    adapter,
    join(privateDir, 'backups'),
    privateDir,
    () => '测试游戏',
  )
  cleanups.push(() => backups.stop())
  const scanner = new WindowsSyncScanner(adapter)
  cleanups.push(() => scanner.stop())
  return { base, saveDir, emptyDir, adapter, saveRoot, emptyRoot, backups, scanner, cleanups }
}

async function scan(scanner, rootId) {
  const started = scanner.start(rootId)
  const done = await scanner.wait(started.scanId)
  assert.equal(done.status, 'succeeded', JSON.stringify(done))
  return done.snapshot
}

async function readStream(stream) {
  const chunks = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

async function waitManual(registry, taskId) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const state = registry.state(taskId)
    if (state.status !== 'running') {
      return state
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('手动备份等待超时')
}

test('手动备份可创建并恢复，空目录不创建空轮次', async (t) => {
  const fixture = await setup(t)
  assert.deepEqual(await fixture.backups.setKeepCount(15), {
    schemaVersion: BACKUP_SETTINGS_SCHEMA_VERSION,
    keepCount: 15,
  })
  assert.equal((await fixture.backups.settings()).keepCount, 15)

  const emptySnapshot = await scan(fixture.scanner, fixture.emptyRoot.rootId)
  const emptyCommit = await fixture.backups.createManual('game-empty', emptySnapshot)
  assert.equal(emptyCommit.manifest, null)
  assert.equal((await fixture.backups.list('game-empty')).backups.length, 0)

  const snapshot = await scan(fixture.scanner, fixture.saveRoot.rootId)
  const commit = await fixture.backups.createManual('game-1', snapshot)
  assert.ok(commit.manifest)
  assert.equal(commit.manifest.reason, 'manual')
  assert.equal(commit.manifest.files.length, 1)
  assert.equal(commit.cleanupError, null)

  const handle = await fixture.backups.acquire('game-1', commit.manifest.backupId)
  try {
    const { stream, verifyUnchanged } = await handle.openFile(commit.manifest.files[0].fileId)
    const content = await readStream(stream)
    await verifyUnchanged()
    assert.equal(content.toString('utf8'), 'manual backup content 1')
  } finally {
    await handle.release()
  }
})

test('自动备份与手动备份按保留份数平级轮换', async (t) => {
  const fixture = await setup(t)
  await fixture.backups.setKeepCount(2)

  const first = await fixture.backups.createManual(
    'game-1',
    await scan(fixture.scanner, fixture.saveRoot.rootId),
  )
  assert.ok(first.manifest)

  const targetSnapshot = await scan(fixture.scanner, fixture.saveRoot.rootId)
  const sourceSnapshot = {
    schemaVersion: 1,
    scanId: 'remote-scan',
    deviceId: 'remote-device',
    rootId: 'remote-root',
    observedAt: Date.now(),
    entries: [
      {
        entryId: 'r-1',
        path: ['slot1.sav'],
        kind: 'file',
        sizeBytes: 99,
        modifiedAt: Date.now(),
        error: null,
      },
    ],
    error: null,
  }
  const plan = createSyncPlan({
    planId: 'plan-1',
    projectId: 'game-1',
    operation: 'copy',
    direction: 'dialer-to-listener',
    shouldBackup: true,
    shouldDeleteExtras: false,
    source: sourceSnapshot,
    target: targetSnapshot,
  })
  const second = await fixture.backups.create(plan)
  assert.ok(second.manifest)
  assert.equal(second.manifest.reason, 'copy')

  const third = await fixture.backups.createManual(
    'game-1',
    await scan(fixture.scanner, fixture.saveRoot.rootId),
  )
  assert.ok(third.manifest)

  const listing = await fixture.backups.list('game-1')
  assert.deepEqual(
    listing.backups.map((item) => item.backupId),
    [third.manifest.backupId, second.manifest.backupId],
  )
  assert.deepEqual(
    listing.backups.map((item) => item.reason),
    ['manual', 'copy'],
  )
})

test('手动备份管理器支持异步完成、空目录与 TargetOperation 名额互斥', async (t) => {
  const fixture = await setup(t)
  const library = {
    snapshot: () => ({
      config: {
        schemaVersion: 2,
        games: [
          { id: 'game-1', name: '测试游戏', rootId: fixture.saveRoot.rootId, links: [] },
          { id: 'game-empty', name: '空游戏', rootId: fixture.emptyRoot.rootId, links: [] },
        ],
        devices: [],
        excludedLinks: [],
      },
      peers: [],
      roots: [],
    }),
  }
  const registry = new WindowsManualBackupRegistry({
    source: fixture.adapter,
    backups: fixture.backups,
    library,
  })
  fixture.cleanups.push(() => registry.stop())

  const external = Symbol('busy')
  acquireTargetOperation(external)
  try {
    assert.throws(
      () => registry.start('game-1'),
      (error) => error?.operationError?.code === 'busy',
    )
  } finally {
    releaseTargetOperation(external)
  }

  const started = registry.start('game-1')
  assert.equal(started.status, 'running')
  assert.equal(hasTargetOperation(), true)
  assert.throws(
    () => registry.start('game-empty'),
    (error) => error?.operationError?.code === 'busy',
  )

  const finished = await waitManual(registry, started.taskId)
  assert.equal(finished.status, 'succeeded')
  assert.ok(finished.backupId)
  assert.equal(finished.fileCount, 1)
  assert.equal(hasTargetOperation(), false)

  const emptyStarted = registry.start('game-empty')
  const emptyFinished = await waitManual(registry, emptyStarted.taskId)
  assert.equal(emptyFinished.status, 'empty')
  assert.equal(emptyFinished.backupId, null)
  assert.equal(hasTargetOperation(), false)
})
