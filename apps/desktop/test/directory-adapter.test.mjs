import assert from 'node:assert/strict'
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import test from 'node:test'
import { createDirectoryAdapter } from '../src/main/directory-adapter.ts'
import { isWithinDirectory } from '../src/main/directory-paths.ts'

async function createFixture(t) {
  // Windows 的 TEMP 可能含 8.3 别名，夹具与适配器须使用一致的真实路径。
  const temporaryRoot = await realpath(tmpdir())
  const base = await mkdtemp(join(temporaryRoot, 'savedata-directory-test-'))
  t.after(async () => {
    const child = relative(temporaryRoot, base)
    assert.ok(isAbsolute(base) && child && child !== '..' && !child.startsWith(`..${sep}`))
    assert.ok(!isAbsolute(child) && base.includes('savedata-directory-test-'))
    await rm(base, { recursive: true, force: true })
  })
  const root = join(base, '存档 目录')
  const outside = join(base, '外部目录')
  const config = join(base, 'control', 'directories.json')
  await mkdir(root)
  await mkdir(outside)
  const adapter = await createDirectoryAdapter(config)
  return { base, root, outside, config, adapter }
}

function value(result) {
  assert.equal(result.status, 'success', JSON.stringify(result))
  return result.value
}

async function collect(stream) {
  const chunks = []
  for await (const chunk of stream) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

test('登记配置与目录分离，重启保留设备和根 ID，不持久化文件清单', async (t) => {
  const { root, config, adapter } = await createFixture(t)
  await writeFile(join(root, '中文 空文件.sav'), '')
  const before = await readdir(root)
  const selected = value(await adapter.registerDirectory(root))
  const listing = value(await adapter.listDirectory(selected.rootId))
  assert.deepEqual(await readdir(root), before)
  const stored = JSON.parse(await readFile(config, 'utf8'))
  assert.deepEqual(Object.keys(stored).sort(), ['deviceId', 'roots', 'schemaVersion'])
  assert.equal('entries' in stored, false)
  const restored = await createDirectoryAdapter(config)
  const roots = value(await restored.listRoots())
  assert.equal(restored.deviceId, adapter.deviceId)
  assert.equal(roots[0].rootId, selected.rootId)
  assert.equal(roots[0].authorization, 'granted')
  assert.equal('path' in roots[0], false)
  assert.equal((await restored.openFile(listing.entries[0])).error.code, 'not-found')
  assert.equal(value(await restored.listDirectory(selected.rootId)).entries[0].sizeBytes, 0)
})

test('只读取当前层，目录大小恒为空，展开后才访问后代', async (t) => {
  const { root, outside, adapter } = await createFixture(t)
  await mkdir(join(root, '子目录'))
  await symlink(outside, join(root, '子目录', 'junction'), 'junction')
  await writeFile(join(root, '存档 01.sav'), '内容')
  const selected = value(await adapter.registerDirectory(root))
  const listing = value(await adapter.listDirectory(selected.rootId))
  const directory = listing.entries.find((entry) => entry.kind === 'directory')
  assert.equal(directory.sizeBytes, null)
  assert.equal(typeof directory.modifiedAt, 'number')
  assert.equal(
    listing.entries.find((entry) => entry.kind === 'file').sizeBytes,
    Buffer.byteLength('内容'),
  )
  assert.equal(
    (await adapter.listDirectory(selected.rootId, directory.entryId)).error.code,
    'path-outside-root',
  )
})
test('空目录成功，与失效、未登记及非法引用的错误不同', async (t) => {
  const { root, base, adapter } = await createFixture(t)
  const selected = value(await adapter.registerDirectory(root))
  assert.deepEqual(value(await adapter.listDirectory(selected.rootId)).entries, [])
  assert.equal((await adapter.listDirectory('unknown-root')).error.code, 'not-found')
  for (const rootId of ['../escape', 'E:/outside', '%2e%2e']) {
    assert.equal((await adapter.listDirectory(rootId)).error.code, 'invalid-request')
  }
  await rename(root, join(base, 'moved'))
  assert.equal(value(await adapter.listRoots())[0].authorization, 'unavailable')
  assert.equal((await adapter.listDirectory(selected.rootId)).error.code, 'not-found')
})

test('符号链接和 junction 根/祖先不允许登记，兄弟同名前缀不算根内', async (t) => {
  const { base, root, outside, adapter } = await createFixture(t)
  const alias = join(base, 'alias')
  await symlink(root, alias, 'junction')
  assert.equal((await adapter.registerDirectory(alias)).error.code, 'path-outside-root')
  await mkdir(join(root, 'nested'))
  assert.equal(
    (await adapter.registerDirectory(join(alias, 'nested'))).error.code,
    'path-outside-root',
  )
  assert.equal(isWithinDirectory(root, `${root}-sibling`), false)
  assert.equal(isWithinDirectory(root, outside), false)
  assert.equal(isWithinDirectory(root, join(root, 'nested')), true)
})

test('文件读流验证引用归属，拒绝文件当目录和跨根引用', async (t) => {
  const { root, outside, adapter } = await createFixture(t)
  const bytes = Buffer.alloc(160000, 42)
  await writeFile(join(root, 'large.sav'), bytes)
  const selected = value(await adapter.registerDirectory(root))
  const entry = value(await adapter.listDirectory(selected.rootId)).entries[0]
  const opened = value(await adapter.openFile(entry))
  assert.deepEqual(await collect(opened.stream), bytes)
  assert.equal(opened.stream.closed, true)
  assert.equal(
    (await adapter.listDirectory(selected.rootId, entry.entryId)).error.code,
    'invalid-request',
  )
  const other = value(await adapter.registerDirectory(outside))
  assert.equal((await adapter.openFile({ ...entry, rootId: other.rootId })).error.code, 'not-found')
  assert.equal(
    (await adapter.openFile({ ...entry, entryId: '../large.sav' })).error.code,
    'invalid-request',
  )
})

test('条目替换或改为联接后不打开旧引用指向的其他对象', async (t) => {
  const { root, outside, adapter } = await createFixture(t)
  const file = join(root, 'save.sav')
  await writeFile(file, 'old')
  const selected = value(await adapter.registerDirectory(root))
  const entry = value(await adapter.listDirectory(selected.rootId)).entries[0]
  await rename(file, join(root, 'old.sav'))
  await writeFile(file, 'new')
  assert.equal((await adapter.openFile(entry)).error.code, 'source-changed')
  const refreshed = value(await adapter.listDirectory(selected.rootId)).entries.find(
    (item) => item.name === 'save.sav',
  )
  assert.equal((await collect(value(await adapter.openFile(refreshed)).stream)).toString(), 'new')
  await mkdir(join(root, 'directory'))
  const directory = value(await adapter.listDirectory(selected.rootId)).entries.find(
    (item) => item.kind === 'directory',
  )
  await rename(join(root, 'directory'), join(root, 'old-directory'))
  await symlink(outside, join(root, 'directory'), 'junction')
  assert.equal(
    (await adapter.listDirectory(selected.rootId, directory.entryId)).error.code,
    'path-outside-root',
  )
})
