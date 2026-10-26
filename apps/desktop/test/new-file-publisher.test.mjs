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
  rename,
  rm,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { isFileOutcome } from '@savedata-sync/shared'
import { createDirectoryAdapter } from '../src/main/directory-adapter.ts'
import { WindowsNewFilePublisher } from '../src/main/new-file-publisher.ts'
import { PublicationError } from '../src/main/publication-errors.ts'
import { createWindowsArchiveAdapter } from '../src/main/archive-adapter.ts'

const HASH = (bytes) => createHash('sha256').update(bytes).digest('hex')
const unwrap = (result) => {
  assert.equal(result.status, 'success', JSON.stringify(result))
  return result.value
}
const sleep = () => new Promise((resolve) => setTimeout(resolve, 1))

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

test('显式已有父目录可发布，跨根引用或把普通文件当父目录均拒绝', async (t) => {
  const fixture = await setup(t)
  await mkdir(join(fixture.root, '子目录'))
  await writeFile(join(fixture.root, '现有.sav'), 'existing')
  const listing = unwrap(await fixture.source.listDirectory(fixture.selected.rootId))
  const parent = listing.entries.find((entry) => entry.kind === 'directory')
  const file = listing.entries.find((entry) => entry.kind === 'file')
  const bytes = Buffer.from('子文件')
  const result = await fixture.publish(bytes, { parentId: parent.entryId })
  assert.equal(result.outcome.status, 'succeeded')
  assert.equal(result.outcome.entry.parentId, parent.entryId)
  assert.deepEqual(await readFile(join(fixture.root, '子目录', result.outcome.entry.name)), bytes)
  assert.equal(
    (await fixture.publish(bytes, { parentId: file.entryId })).outcome.error.code,
    'invalid-request',
  )
  const foreign = unwrap(await fixture.source.listDirectory(fixture.readonlySelected.rootId))
    .entries[0]
  assert.equal(
    (await fixture.publish(bytes, { parentId: foreign.entryId })).outcome.error.code,
    'not-found',
  )
})

test('非法名称、路径、额外字段和声明不合法均抛稳定错误并关闭输入', async (t) => {
  const fixture = await setup(t)
  const bytes = Buffer.from('data')
  for (const changes of [
    { name: '../escape' },
    { name: 'C:\\save.sav' },
    { name: 'CON' },
    { name: 'save.' },
    { name: '\ud800' },
    { parentId: '../parent' },
    { rootId: 'content://uri' },
    { fileId: 'wrong' },
    { sizeBytes: -1 },
    { sizeBytes: 268435457 },
    { sha256: 'BAD' },
    { extra: true },
  ]) {
    const input = Readable.from([bytes])
    await assert.rejects(
      fixture.publisher.publish(fixture.makeRequest(bytes, changes), input),
      (error) =>
        error instanceof PublicationError && error.operationError.code === 'invalid-request',
    )
    assert.equal(input.destroyed, true)
  }
  assert.deepEqual(await readdir(fixture.root), [])
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

test('检查后出现目标的真实竞争由 link 排他拒绝，竞争文件不被修改', async (t) => {
  const fixture = await setup(t, {
    configuration: {
      io: {
        link: async (candidate, target) => {
          await writeFile(target, '竞争文件', { flag: 'wx' })
          await link(candidate, target)
        },
      },
    },
  })
  const result = await fixture.publish(Buffer.from('待发布内容'))
  assert.equal(result.outcome.error.code, 'name-conflict')
  assert.equal(await readFile(join(fixture.root, '新 存档 😀.sav'), 'utf8'), '竞争文件')
  assert.equal(result.cleanupStatus, 'complete')
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

test('本机预算只能收紧，等于预算允许，声明超限在创建候选前拒绝', async (t) => {
  const fixture = await setup(t, { configuration: { maxFileBytes: 17 } })
  assert.equal((await fixture.publish(Buffer.alloc(17))).outcome.status, 'succeeded')
  assert.equal(
    (await fixture.publish(Buffer.alloc(18), { name: 'too-large.sav' })).outcome.error.code,
    'resource-limit',
  )
  assert.throws(
    () => fixture.create({ maxFileBytes: 268435457 }),
    (error) => error.operationError.code === 'invalid-request',
  )
  await assertNoCandidates(fixture.root)
})

test('磁盘空间不足与 sync 失败反馈原始错误，已有文件不受影响', async (t) => {
  const fixture = await setup(t, { configuration: { io: { availableBytes: async () => 0n } } })
  const result = await fixture.publish(Buffer.from('content'))
  assert.equal(result.outcome.error.code, 'insufficient-space')
  assert.deepEqual(await readdir(fixture.root), [])
  const second = fixture.create({
    io: {
      sync: async () => {
        throw Object.assign(new Error('私有路径不可外泄'), { code: 'EIO' })
      },
    },
  })
  await second.grant(fixture.selected.rootId)
  const failure = await second.publish(
    fixture.makeRequest(Buffer.from('data')),
    Readable.from([Buffer.from('data')]),
  )
  assert.equal(failure.outcome.error.code, 'io-failure')
  assert.ok(!JSON.stringify(failure).includes('私有路径'))
  assert.deepEqual(await readdir(fixture.root), [])
})

test('不支持 link 的卷明确失败，不退回覆盖 rename 或直接写最终路径', async (t) => {
  const fixture = await setup(t, {
    configuration: {
      io: {
        link: async () => {
          throw Object.assign(new Error('unsupported'), { code: 'EXDEV' })
        },
      },
    },
  })
  const result = await fixture.publish(Buffer.from('data'))
  assert.equal(result.outcome.error.code, 'unsupported-operation')
  assert.deepEqual(await readdir(fixture.root), [])
})

test('输入流中断后保持 io-failure，不留下未验证最终文件', async (t) => {
  const fixture = await setup(t)
  const input = Readable.from(
    (async function* () {
      yield Buffer.from('part')
      throw new Error('内部源路径')
    })(),
  )
  const result = await fixture.publisher.publish(
    fixture.makeRequest(Buffer.from('partmore')),
    input,
  )
  assert.equal(result.outcome.error.code, 'io-failure')
  assert.ok(!JSON.stringify(result).includes('内部源路径'))
  assert.equal(input.destroyed, true)
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

test('发布点中的取消以最终回读为准，不删除已经确认成功的新文件', async (t) => {
  const controller = new AbortController()
  const fixture = await setup(t, {
    configuration: {
      io: {
        link: async (candidate, target) => {
          await link(candidate, target)
          controller.abort()
        },
      },
    },
  })
  const bytes = Buffer.from('commit point')
  const result = await fixture.publish(bytes, {}, { signal: controller.signal })
  assert.equal(result.outcome.status, 'succeeded')
  assert.deepEqual(await readFile(join(fixture.root, result.outcome.entry.name)), bytes)
  await assertNoCandidates(fixture.root)
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

test('最终回读不符或路径被替换时不报告成功，也不删除未知最终条目', async (t) => {
  const fixture = await setup(t, {
    configuration: {
      io: {
        link: async (candidate, target) => {
          await link(candidate, target)
          await writeFile(target, '已发生外部修改')
        },
      },
    },
  })
  assert.equal((await fixture.publish(Buffer.from('original'))).outcome.status, 'unknown')
  assert.equal(await readFile(join(fixture.root, '新 存档 😀.sav'), 'utf8'), '已发生外部修改')
  const other = fixture.create({
    io: {
      link: async (candidate, target) => {
        await link(candidate, target)
        await unlink(target)
        await writeFile(target, '替换后的文件', { flag: 'wx' })
      },
    },
  })
  await other.grant(fixture.selected.rootId)
  const result = await other.publish(
    fixture.makeRequest(Buffer.from('original'), { name: 'replaced.sav' }),
    Readable.from([Buffer.from('original')]),
  )
  assert.equal(result.outcome.status, 'unknown')
  assert.equal(await readFile(join(fixture.root, 'replaced.sav'), 'utf8'), '替换后的文件')
  await assertNoCandidates(fixture.root)
})

test('多个原生发布实例共享名额，撤销写授权等待输入和候选收尾', async (t) => {
  const fixture = await setup(t)
  const input = new Readable({ read() {} })
  const result = fixture.publisher.publish(fixture.makeRequest(Buffer.from('data')), input)
  while (!(await readdir(fixture.root)).some((name) => name.startsWith('.savedata-new-')))
    await sleep()
  const other = fixture.create()
  await other.grant(fixture.selected.rootId)
  const busy = await other.publish(
    fixture.makeRequest(Buffer.alloc(0), { name: 'other.sav' }),
    Readable.from([]),
  )
  assert.equal(busy.outcome.error.code, 'busy')
  await fixture.publisher.revoke(fixture.selected.rootId)
  assert.equal((await result).outcome.status, 'cancelled')
  assert.equal(input.destroyed, true)
  assert.equal((await fixture.publish(Buffer.from('new'))).outcome.error.code, 'permission-denied')
  await assertNoCandidates(fixture.root)
})

test('成功与清理失败分开，已发布内容保留；并发重试成功后才允许下一文件', async (t) => {
  const fault = { blocked: true }
  const fixture = await setup(t, {
    configuration: {
      io: {
        unlink: async (path) => {
          if (fault.blocked) throw new Error('cleanup blocked')
          await unlink(path)
        },
      },
    },
  })
  try {
    const result = await fixture.publish(Buffer.from('good'))
    assert.equal(result.outcome.status, 'succeeded')
    assert.equal(result.cleanupStatus, 'incomplete')
    assert.equal(result.cleanupError.code, 'cleanup-failed')
    assert.equal(
      (await fixture.publish(Buffer.from('next'), { name: 'next.sav' })).outcome.error.code,
      'busy',
    )
    assert.equal(await readFile(join(fixture.root, result.outcome.entry.name), 'utf8'), 'good')
    fault.blocked = false
    await Promise.all([fixture.publisher.retryCleanup(), fixture.publisher.retryCleanup()])
    assert.equal(
      (await fixture.publish(Buffer.from('next'), { name: 'next.sav' })).outcome.status,
      'succeeded',
    )
  } finally {
    fault.blocked = false
    await fixture.publisher.retryCleanup()
  }
  await assertNoCandidates(fixture.root)
})

test('校验失败或取消不被清理失败覆盖，确知候选残留有可核实引用', async (t) => {
  const fault = { blocked: true }
  const fixture = await setup(t, {
    configuration: {
      io: {
        unlink: async (path) => {
          if (fault.blocked) throw new Error('cleanup blocked')
          await unlink(path)
        },
      },
    },
  })
  try {
    const result = await fixture.publish(Buffer.from('wrong'), {
      sha256: HASH(Buffer.from('expected')),
    })
    assert.equal(result.outcome.error.code, 'checksum-mismatch')
    assert.equal(result.cleanupStatus, 'incomplete')
    assert.equal(result.outcome.residualEntries.length, 1)
    const residual = unwrap(await fixture.source.openFile(result.outcome.residualEntries[0]))
    for await (const chunk of residual.stream) void chunk
    fault.blocked = false
    await fixture.publisher.retryCleanup()
    fault.blocked = true
    const controller = new AbortController()
    const cancelled = await fixture.publish(
      Buffer.from('cancel'),
      {},
      {
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress.stagedBytes > 0) controller.abort()
        },
      },
    )
    assert.equal(cancelled.outcome.status, 'cancelled')
    assert.equal(cancelled.cleanupStatus, 'incomplete')
  } finally {
    fault.blocked = false
    await fixture.publisher.retryCleanup()
  }
  await assertNoCandidates(fixture.root)
})

test('候选身份替换时清理失败关闭，未知条目不被删除，恢复原候选后可重试', async (t) => {
  const fixture = await setup(t)
  let originalName
  let heldPath
  const bytes = Buffer.from('owned')
  const result = await fixture.publish(
    bytes,
    {},
    {
      onProgress: (progress) => {
        if (progress.stage === 'publishing') throw new Error('暂停于发布之前')
      },
    },
  )
  assert.equal(result.outcome.status, 'failed')
  // 通过 sync 注入真实替换发生在候选关闭前，仍由 inode 身份保护清理。
  const publisher = fixture.create({
    io: {
      sync: async (handle) => {
        await handle.sync()
        originalName = (await readdir(fixture.root)).find((name) =>
          name.startsWith('.savedata-new-'),
        )
        heldPath = join(fixture.root, 'held-owned.tmp')
        assert.ok(!relative(fixture.root, heldPath).startsWith('..'))
        await rename(join(fixture.root, originalName), heldPath)
        await writeFile(join(fixture.root, originalName), 'foreign', { flag: 'wx' })
      },
    },
  })
  await publisher.grant(fixture.selected.rootId)
  try {
    const failure = await publisher.publish(fixture.makeRequest(bytes), Readable.from([bytes]))
    assert.equal(failure.outcome.error.code, 'source-changed')
    assert.equal(failure.cleanupStatus, 'incomplete')
    assert.equal(await readFile(join(fixture.root, originalName), 'utf8'), 'foreign')
    await assert.rejects(
      publisher.retryCleanup(),
      (error) => error.operationError.code === 'cleanup-failed',
    )
  } finally {
    if (heldPath) {
      await unlink(join(fixture.root, originalName))
      await rename(heldPath, join(fixture.root, originalName))
      await publisher.retryCleanup()
    }
  }
  await assertNoCandidates(fixture.root)
})

test('链接父目录与跨根路径不能写入；原目录被替换后旧写授权失效', async (t) => {
  const fixture = await setup(t)
  const outside = join(fixture.base, 'outside')
  await mkdir(outside)
  await symlink(outside, join(fixture.root, 'linked'), 'junction')
  const rejected = await fixture.source.listDirectory(fixture.selected.rootId)
  assert.equal(rejected.status, 'error')
  await unlink(join(fixture.root, 'linked'))
  const held = join(fixture.base, 'held-target')
  assert.ok(!relative(fixture.base, held).startsWith('..'))
  await rename(fixture.root, held)
  await mkdir(fixture.root)
  try {
    const result = await fixture.publish(Buffer.from('no write'))
    assert.equal(result.outcome.error.code, 'source-changed')
    assert.deepEqual(await readdir(fixture.root), [])
  } finally {
    await rmdir(fixture.root)
    await rename(held, fixture.root)
  }
})

test('stop 取消正在写入的任务且可重试清理，停止后必须使用新实例重新授权', async (t) => {
  const fixture = await setup(t)
  const input = new Readable({ read() {} })
  const pending = fixture.publisher.publish(fixture.makeRequest(Buffer.from('data')), input)
  while (!(await readdir(fixture.root)).some((name) => name.startsWith('.savedata-new-')))
    await sleep()
  await Promise.all([fixture.publisher.stop(), fixture.publisher.stop()])
  assert.equal((await pending).outcome.status, 'cancelled')
  await assertNoCandidates(fixture.root)
  assert.equal((await fixture.publish(Buffer.from('new'))).outcome.error.code, 'busy')
  await assert.rejects(
    fixture.publisher.grant(fixture.selected.rootId),
    (error) => error.operationError.code === 'busy',
  )
})

test('消费已验证私有归档原文，返回前关闭输入读流，归档缓存可立即释放', async (t) => {
  const fixture = await setup(t)
  const privateDirectory = join(fixture.base, 'archive-private')
  await mkdir(privateDirectory)
  const archive = await createWindowsArchiveAdapter(fixture.source, privateDirectory)
  const sourceEntry = unwrap(await fixture.source.listDirectory(fixture.readonlySelected.rootId))
    .entries[0]
  const prepared = await archive.prepare({
    protocolVersion: 1,
    transferId: 'publish-integration',
    sourceRootId: fixture.readonlySelected.rootId,
    files: [{ fileId: 'f000001', entryId: sourceEntry.entryId }],
  })
  try {
    const file = prepared.manifest.files[0]
    const result = await fixture.publisher.publish(
      {
        fileId: file.fileId,
        rootId: fixture.selected.rootId,
        parentId: null,
        name: 'from-archive.sav',
        sizeBytes: file.sizeBytes,
        sha256: file.sha256,
      },
      await prepared.openFile(file.fileId),
    )
    assert.equal(result.outcome.status, 'succeeded')
    assert.deepEqual(
      await readFile(join(fixture.root, 'from-archive.sav')),
      await readFile(join(fixture.readonlyRoot, 'source.sav')),
    )
    await prepared.dispose()
    assert.deepEqual(await readdir(join(privateDirectory, 'transfer-archives-v1')), [
      'cache-root.json',
    ])
  } finally {
    await archive.retryCleanup()
  }
})

test('目标预检只读并返回物理父目录比较键，重叠根和大小写别名可在接收前去重', async (t) => {
  const fixture = await setup(t, { grant: false })
  const bytes = Buffer.from('data')
  await assert.rejects(
    fixture.publisher.checkTarget(fixture.makeRequest(bytes)),
    (error) => error.operationError.code === 'permission-denied',
  )
  await fixture.publisher.grant(fixture.selected.rootId)
  const subdirectory = join(fixture.root, 'child')
  await mkdir(subdirectory)
  const parent = unwrap(await fixture.source.listDirectory(fixture.selected.rootId)).entries[0]
  const childRoot = unwrap(await fixture.source.registerDirectory(subdirectory))
  await fixture.publisher.grant(childRoot.rootId)
  const first = await fixture.publisher.checkTarget(
    fixture.makeRequest(bytes, { parentId: parent.entryId, name: 'FILE.sav' }),
  )
  const second = await fixture.publisher.checkTarget(
    fixture.makeRequest(bytes, { rootId: childRoot.rootId, name: 'file.SAV' }),
  )
  assert.equal(first, second)
  assert.ok(!first.includes(fixture.base))
  assert.deepEqual(await readdir(subdirectory), [])
  await writeFile(join(subdirectory, 'file.sav'), 'existing')
  await assert.rejects(
    fixture.publisher.checkTarget(
      fixture.makeRequest(bytes, { parentId: parent.entryId, name: 'FILE.sav' }),
    ),
    (error) => error.operationError.code === 'name-conflict',
  )
})

test('候选写入后父目录被替换时不沿新路径删除，恢复身份后重试清理', async (t) => {
  const heldName = 'held-original-target'
  let hasMoved = false
  const fixture = await setup(t, {
    configuration: {
      io: {
        link: async (candidate, target) => {
          const held = join(fixture.base, heldName)
          assert.ok(!relative(fixture.base, held).startsWith('..'))
          await rename(fixture.root, held)
          hasMoved = true
          await mkdir(fixture.root)
          await writeFile(join(fixture.root, 'foreign.sav'), 'foreign')
          await link(candidate, target)
        },
      },
    },
  })
  try {
    const result = await fixture.publish(Buffer.from('owned'))
    assert.equal(result.outcome.status, 'failed')
    assert.equal(result.outcome.error.code, 'not-found')
    assert.equal(result.cleanupStatus, 'incomplete')
    assert.deepEqual(await readdir(fixture.root), ['foreign.sav'])
    assert.equal((await fixture.publish(Buffer.from('next'))).outcome.error.code, 'busy')
  } finally {
    if (hasMoved) {
      await unlink(join(fixture.root, 'foreign.sav'))
      await rmdir(fixture.root)
      await rename(join(fixture.base, heldName), fixture.root)
      await fixture.publisher.retryCleanup()
    }
  }
  await assertNoCandidates(fixture.root)
})
