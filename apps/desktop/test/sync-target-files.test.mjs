import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { access, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { writeCandidateName } from '@savedata-sync/shared'
import { createDirectoryAdapter } from '../src/main/directory-adapter.ts'
import { SYNC_TARGET_IO, removeLeftoverCandidates } from '../src/main/sync-target-files.ts'

const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  )

test('删除目标目录各层的候选文件残留，保留其他文件和链接指向目录里的文件', async (t) => {
  // Windows 的 TEMP 可能含 8.3 别名，夹具与适配器须使用一致的真实路径。
  const base = await mkdtemp(join(await realpath(tmpdir()), 'savedata-target-test-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'root')
  const outside = join(base, 'outside')
  await mkdir(join(root, 'save', 'deep'), { recursive: true })
  await mkdir(outside)
  const leftovers = [
    join(root, writeCandidateName('new', randomUUID())),
    join(root, 'save', 'deep', writeCandidateName('copy', randomUUID())),
  ]
  const kept = [
    join(root, 'save', 'a.sav'),
    join(root, `.savedata-copy-${randomUUID().toUpperCase()}.tmp`),
    join(outside, writeCandidateName('copy', randomUUID())),
  ]
  for (const path of [...leftovers, ...kept]) {
    await writeFile(path, 'x')
  }
  await symlink(outside, join(root, 'link'), 'junction')

  const adapter = await createDirectoryAdapter(join(base, 'control', 'directories.json'))
  const selected = await adapter.registerDirectory(root)
  assert.equal(selected.status, 'success')
  const location = await adapter.locateNativeDirectory(selected.value.rootId)
  await removeLeftoverCandidates(location, SYNC_TARGET_IO, new AbortController().signal)

  for (const path of leftovers) {
    assert.equal(await exists(path), false, path)
  }
  for (const path of kept) {
    assert.equal(await exists(path), true, path)
  }
})
