import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { isFileOutcome } from '@savedata-sync/shared'
import { createDirectoryAdapter } from '../src/main/directory-adapter.ts'
import { WindowsNewFilePublisher } from '../src/main/new-file-publisher.ts'

const HASH = (bytes) => createHash('sha256').update(bytes).digest('hex')
const unwrap = (result) => {
  assert.equal(result.status, 'success', JSON.stringify(result))
  return result.value
}
async function setup(t, options = {}) {
  const temporaryRoot = await realpath(tmpdir())
  const base = await mkdtemp(join(temporaryRoot, 'savedata-publish-test-'))
  const root = join(base, '专用目标')
  const readonlyRoot = join(base, '只读源')
  await mkdir(root)
  await mkdir(readonlyRoot)
  const original = Buffer.from('只读源内容，不得修改')
  const originalPath = join(readonlyRoot, 'source.sav')
  await writeFile(originalPath, original)
  const before = await lstat(originalPath, { bigint: true })
  const source = await createDirectoryAdapter(join(base, 'control', 'directories.json'))
  const selected = unwrap(await source.registerDirectory(root))
  const readonlySelected = unwrap(await source.registerDirectory(readonlyRoot))
  const publishers = []
  const create = (configuration) => {
    const publisher = new WindowsNewFilePublisher(source, configuration)
    publishers.push(publisher)
    return publisher
  }
  const publisher = create(options.configuration)
  if (options.grant !== false) await publisher.grant(selected.rootId)
  t.after(async () => {
    for (const instance of publishers) await instance.stop()
    assert.deepEqual(await readFile(originalPath), original)
    const after = await lstat(originalPath, { bigint: true })
    for (const field of ['size', 'mtimeNs', 'ctimeNs', 'dev', 'ino'])
      assert.equal(after[field], before[field])
    const child = relative(temporaryRoot, base)
    assert.ok(
      child &&
        child !== '..' &&
        !child.startsWith(`..${sep}`) &&
        !isAbsolute(child) &&
        base.includes('savedata-publish-test-'),
    )
    await rm(base, { recursive: true, force: true })
  })
  const makeRequest = (bytes, overrides = {}) => ({
    fileId: 'f000001',
    rootId: selected.rootId,
    parentId: null,
    name: '新 存档 😀.sav',
    sizeBytes: bytes.length,
    sha256: HASH(bytes),
    ...overrides,
  })
  const publish = async (bytes, overrides = {}, operation = {}) => {
    const input = Readable.from([bytes])
    const result = await publisher.publish(makeRequest(bytes, overrides), input, operation)
    assert.ok(isFileOutcome(result.outcome), JSON.stringify(result))
    assert.equal(input.destroyed, true)
    return result
  }
  return {
    base,
    root,
    readonlyRoot,
    source,
    selected,
    readonlySelected,
    publisher,
    create,
    makeRequest,
    publish,
  }
}

async function assertNoCandidates(root) {
  assert.ok(!(await readdir(root)).some((name) => name.startsWith('.savedata-new-')))
}

test('空文件、Unicode 与超过缓冲区原文独占发布，最终属性和原生读流可复验', async (t) => {
  const fixture = await setup(t)
  for (const [index, bytes] of [
    Buffer.alloc(0),
    Buffer.from('合成存档'),
    Buffer.alloc(131073, 29),
  ].entries()) {
    const name = `存档 % 😀 ${index}.sav`
    const result = await fixture.publish(bytes, { name })
    assert.equal(result.outcome.status, 'succeeded')
    assert.equal(result.outcome.bytesWritten, bytes.length)
    assert.equal(result.outcome.sha256, HASH(bytes))
    assert.equal(result.outcome.entry.name, name)
    assert.equal(result.outcome.entry.rootId, fixture.selected.rootId)
    assert.equal(result.cleanupStatus, 'complete')
    assert.deepEqual(await readFile(join(fixture.root, name)), bytes)
    const opened = unwrap(await fixture.source.openFile(result.outcome.entry))
    const chunks = []
    for await (const chunk of opened.stream) chunks.push(chunk)
    assert.deepEqual(Buffer.concat(chunks), bytes)
    assert.equal((await lstat(join(fixture.root, name), { bigint: true })).nlink, 1n)
  }
  await assertNoCandidates(fixture.root)
})

test('读取登记不授予写入，新实例没有旧授权，有限目录能力保持只读', async (t) => {
  const fixture = await setup(t, { grant: false })
  const bytes = Buffer.from('新内容')
  assert.equal((await fixture.publish(bytes)).outcome.error.code, 'permission-denied')
  await fixture.publisher.grant(fixture.selected.rootId)
  assert.equal((await fixture.publish(bytes)).outcome.status, 'succeeded')
  const other = fixture.create()
  const result = await other.publish(
    fixture.makeRequest(bytes, { name: 'other.sav' }),
    Readable.from([bytes]),
  )
  assert.equal(result.outcome.error.code, 'permission-denied')
  const listing = unwrap(await fixture.source.listDirectory(fixture.selected.rootId))
  assert.equal(listing.entries[0].capabilities.canCreate, 'unsupported')
})

test('同名、大小写等价名及已有目录都不覆盖，已有内容与身份保持', async (t) => {
  const fixture = await setup(t)
  const path = join(fixture.root, 'SAVE.sav')
  await writeFile(path, '原始内容')
  const before = await lstat(path, { bigint: true })
  await mkdir(join(fixture.root, 'folder'))
  for (const name of ['SAVE.sav', 'save.SAV', 'folder'])
    assert.equal(
      (await fixture.publish(Buffer.from('new'), { name })).outcome.error.code,
      'name-conflict',
    )
  assert.equal(await readFile(path, 'utf8'), '原始内容')
  const after = await lstat(path, { bigint: true })
  for (const field of ['ino', 'dev', 'mtimeNs', 'size']) assert.equal(after[field], before[field])
  await assertNoCandidates(fixture.root)
})

test('输入少于/超过声明、哈希错误或非二进制流均不发布，候选完整清理', async (t) => {
  const fixture = await setup(t)
  const bytes = Buffer.from('actual')
  for (const changes of [
    { sizeBytes: bytes.length - 1 },
    { sizeBytes: bytes.length + 1 },
    { sha256: HASH(Buffer.from('other')) },
  ]) {
    const result = await fixture.publish(bytes, changes)
    assert.equal(result.outcome.error.code, 'checksum-mismatch')
    assert.equal(result.cleanupStatus, 'complete')
  }
  const result = await fixture.publisher.publish(
    fixture.makeRequest(bytes),
    Readable.from(['text']),
  )
  assert.equal(result.outcome.error.code, 'invalid-request')
  assert.deepEqual(await readdir(fixture.root), [])
})

test('预先取消、中途取消与超时关闭输入并清理，未跨发布点时无最终文件', async (t) => {
  const fixture = await setup(t)
  const pre = new AbortController()
  pre.abort()
  assert.equal(
    (await fixture.publish(Buffer.from('data'), {}, { signal: pre.signal })).outcome.status,
    'cancelled',
  )
  const controller = new AbortController()
  const result = await fixture.publish(
    Buffer.alloc(131073),
    {},
    {
      signal: controller.signal,
      onProgress: (progress) => {
        if (progress.stagedBytes > 0) controller.abort()
      },
    },
  )
  assert.equal(result.outcome.status, 'cancelled')
  const timeout = new AbortController()
  timeout.abort(new DOMException('deadline', 'TimeoutError'))
  assert.equal(
    (await fixture.publish(Buffer.from('data'), {}, { signal: timeout.signal })).outcome.error.code,
    'timeout',
  )
  assert.deepEqual(await readdir(fixture.root), [])
})

test('link 已发生但回执失败时反馈 unknown，保留实际最终文件而不重放', async (t) => {
  const fixture = await setup(t, {
    configuration: {
      io: {
        link: async (candidate, target) => {
          await link(candidate, target)
          throw new Error('link completion lost')
        },
      },
    },
  })
  const bytes = Buffer.from('unknown commit')
  const result = await fixture.publish(bytes)
  assert.equal(result.outcome.status, 'unknown')
  assert.equal(result.outcome.error.canRetry, false)
  assert.deepEqual(await readFile(join(fixture.root, '新 存档 😀.sav')), bytes)
  await assertNoCandidates(fixture.root)
})
