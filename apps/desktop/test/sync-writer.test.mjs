import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { createSyncPlan, NOMEDIA_NAME } from '@savedata-sync/shared'
import { createDesktopBackupStore } from '../src/backend/backup-store.ts'
import { createDirectoryAdapter } from '../src/backend/directory-adapter.ts'
import { InterruptedWriteStore } from '../src/backend/interrupted-writes.ts'
import { DesktopSyncScanner } from '../src/backend/sync-scanner.ts'
import { SYNC_TARGET_IO } from '../src/backend/sync-target-files.ts'
import { DesktopSyncWriter } from '../src/backend/sync-writer.ts'

const SOURCE_MODIFIED_AT = Date.UTC(2026, 0, 1)

async function setup(t, { io } = {}) {
  const base = await mkdtemp(join(await realpath(tmpdir()), 'savedata-writer-test-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const target = join(base, 'target')
  const privateDir = join(base, 'private')
  await mkdir(join(target, 'keep'), { recursive: true })
  await mkdir(join(target, 'extra-dir'))
  await mkdir(privateDir)
  await writeFile(join(target, 'keep', 'slot.sav'), 'old slot')
  await writeFile(join(target, 'dropped.sav'), 'extra')
  // 扫描看不到 .nomedia，只剩它的多余文件夹要连同它删除。
  await writeFile(join(target, 'extra-dir', NOMEDIA_NAME), '')
  const adapter = await createDirectoryAdapter(join(privateDir, 'directories.json'))
  const selected = await adapter.registerDirectory(target)
  assert.equal(selected.status, 'success')
  const backups = await createDesktopBackupStore(
    adapter,
    join(privateDir, 'backups'),
    privateDir,
    () => 'Writer Test',
  )
  t.after(() => backups.stop())
  const scanner = new DesktopSyncScanner(adapter)
  t.after(() => scanner.stop())
  const interruptedWrites = new InterruptedWriteStore(privateDir)
  const writer = new DesktopSyncWriter(adapter, backups, {
    authorize: () => undefined,
    interruptedWrites,
    ...(io ? { io } : {}),
  })
  t.after(() => writer.stop())
  const done = await scanner.wait(scanner.start(selected.value.rootId).scanId)
  assert.equal(done.status, 'succeeded', JSON.stringify(done.error))
  return { target, privateDir, backups, writer, interruptedWrites, targetSnapshot: done.snapshot }
}

/** 来自另一台设备的来源：覆盖 keep/slot.sav，新建 new/a.sav。 */
function sourceMaterial() {
  const files = new Map([
    ['s-slot', { path: ['keep', 'slot.sav'], content: Buffer.from('new slot content') }],
    ['s-a', { path: ['new', 'a.sav'], content: Buffer.from('new file a') }],
  ])
  const entry = (entryId, path, kind, sizeBytes) => ({
    entryId,
    path,
    kind,
    sizeBytes,
    modifiedAt: SOURCE_MODIFIED_AT,
    error: null,
  })
  const snapshot = {
    schemaVersion: 1,
    scanId: 'source-scan',
    deviceId: 'source-device',
    rootId: 'source-root',
    observedAt: Date.now(),
    entries: [
      entry('s-keep', ['keep'], 'directory', null),
      entry('s-new', ['new'], 'directory', null),
      ...[...files].map(([id, file]) => entry(id, file.path, 'file', file.content.length)),
    ],
    error: null,
  }
  return {
    files,
    material: {
      snapshot,
      openFile: async (entryId) => ({
        stream: Readable.from([files.get(entryId).content]),
        verifyUnchanged: async () => undefined,
      }),
    },
  }
}

function copyPlan(fixture, material, planId = 'plan-copy') {
  return createSyncPlan({
    planId,
    projectId: 'game-1',
    operation: 'copy',
    direction: 'dialer-to-listener',
    shouldBackup: true,
    shouldDeleteExtras: true,
    source: material.snapshot,
    target: fixture.targetSnapshot,
  })
}

/** 列出目录下全部条目（含扫描会跳过的文件），文件带内容。 */
async function readTree(root, prefix = '') {
  const tree = {}
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      tree[`${path}/`] = null
      Object.assign(tree, await readTree(root, path))
    } else {
      tree[path] = await readFile(join(root, path), 'utf8')
    }
  }
  return tree
}

test('按计划写入后目标与来源一致，覆盖和删除前的文件进了备份，不留候选文件和写入标记', async (t) => {
  const fixture = await setup(t)
  const { material } = sourceMaterial()
  const result = await fixture.writer.apply(copyPlan(fixture, material), material)

  assert.equal(result.error, null)
  assert.equal(result.cleanupError, null)
  assert.ok(result.outcomes.every((item) => item.status === 'succeeded'))
  assert.deepEqual(await readTree(fixture.target), {
    'keep/': null,
    'keep/slot.sav': 'new slot content',
    'new/': null,
    'new/a.sav': 'new file a',
  })
  const handle = await fixture.backups.acquire('game-1', result.backupId)
  try {
    const saved = handle.snapshot().entries.filter((entry) => entry.kind === 'file')
    assert.deepEqual(saved.map((entry) => entry.path.join('/')).sort(), [
      'dropped.sav',
      'keep/slot.sav',
    ])
    const slot = saved.find((entry) => entry.path.join('/') === 'keep/slot.sav')
    const chunks = []
    const { stream } = await handle.openFile(slot.entryId)
    for await (const chunk of stream) {
      chunks.push(chunk)
    }
    assert.equal(Buffer.concat(chunks).toString('utf8'), 'old slot')
  } finally {
    await handle.release()
  }
  assert.deepEqual(await fixture.interruptedWrites.list(), [])
})

test('同一份确认不能执行第二次', async (t) => {
  const fixture = await setup(t)
  const { material } = sourceMaterial()
  const plan = copyPlan(fixture, material)
  await fixture.writer.apply(plan, material)

  assert.throws(
    () => fixture.writer.apply(plan, material),
    (error) => error?.operationError?.code === 'task-conflict',
  )
})

test('确认后目标被改动时一项不写，报告 source-changed', async (t) => {
  const fixture = await setup(t)
  const { material } = sourceMaterial()
  const plan = copyPlan(fixture, material)
  await writeFile(join(fixture.target, 'keep', 'slot.sav'), 'changed by the game')
  const before = await readTree(fixture.target)

  const result = await fixture.writer.apply(plan, material)

  assert.equal(result.error?.code, 'source-changed')
  assert.ok(result.outcomes.every((item) => item.status !== 'succeeded'))
  assert.deepEqual(await readTree(fixture.target), before)
})

test('删除前文件被改动时保留它并停止后项，已完成的写入保留', async (t) => {
  const fixture = await setup(t)
  const { material } = sourceMaterial()
  let stagePath = null
  const result = await fixture.writer.apply(copyPlan(fixture, material), material, {
    onStage: (_stage, path) => {
      stagePath = path?.join('/') ?? null
    },
    verifyContext: async () => {
      if (stagePath === 'dropped.sav') {
        await writeFile(join(fixture.target, 'dropped.sav'), 'changed before delete')
      }
    },
  })

  const byPath = new Map(result.outcomes.map((item) => [item.path.join('/'), item.status]))
  assert.equal(byPath.get('dropped.sav'), 'failed')
  assert.equal(byPath.get('extra-dir'), 'not-attempted')
  assert.equal(byPath.get('new/a.sav'), 'succeeded')
  const tree = await readTree(fixture.target)
  assert.equal(tree['dropped.sav'], 'changed before delete')
  assert.equal(tree['new/a.sav'], 'new file a')
  assert.ok('extra-dir/' in tree)
})

test('要删除的文件夹里出现别的文件时不删', async (t) => {
  const fixture = await setup(t)
  const { material } = sourceMaterial()
  let stagePath = null
  const result = await fixture.writer.apply(copyPlan(fixture, material), material, {
    onStage: (_stage, path) => {
      stagePath = path?.join('/') ?? null
    },
    verifyContext: async () => {
      if (stagePath === 'extra-dir') {
        await writeFile(join(fixture.target, 'extra-dir', 'late.sav'), 'late')
      }
    },
  })

  const failed = result.outcomes.find((item) => item.path.join('/') === 'extra-dir')
  assert.equal(failed.status, 'failed')
  assert.equal((await readTree(fixture.target))['extra-dir/late.sav'], 'late')
})

test('写入途中进程结束时，下次启动能列出写入标记和这次的备份', async (t) => {
  let releaseLink
  const linkGate = new Promise((resolve) => {
    releaseLink = resolve
  })
  let reachedLink
  const linkReached = new Promise((resolve) => {
    reachedLink = resolve
  })
  const fixture = await setup(t, {
    io: {
      // 停在第一次发布新文件之前，模拟写入途中进程被结束。
      link: async (...args) => {
        reachedLink()
        await linkGate
        return SYNC_TARGET_IO.link(...args)
      },
    },
  })
  const { material } = sourceMaterial()
  const running = fixture.writer.apply(copyPlan(fixture, material), material)
  await linkReached

  const nextProcess = new InterruptedWriteStore(fixture.privateDir)
  const [marker] = await nextProcess.list()
  assert.equal(marker?.id, 'plan-copy')
  assert.equal(marker.projectId, 'game-1')
  assert.equal(marker.rootId, fixture.targetSnapshot.rootId)
  assert.ok(marker.backupId)

  releaseLink()
  const result = await running
  assert.equal(result.backupId, marker.backupId)
  assert.deepEqual(await nextProcess.list(), [])
})
