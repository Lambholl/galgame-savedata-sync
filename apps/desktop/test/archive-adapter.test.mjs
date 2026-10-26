import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { Readable } from 'node:stream'
import { gzipSync, gunzipSync } from 'node:zlib'
import test from 'node:test'
import { createWindowsArchiveAdapter } from '../src/main/archive-adapter.ts'
import { ArchiveCancelledError, ArchiveError } from '../src/main/archive-errors.ts'
import { createDirectoryAdapter } from '../src/main/directory-adapter.ts'

const FIXTURE = JSON.parse(
  await readFile(new URL('./fixtures/archive-v1.json', import.meta.url), 'utf8'),
)
const HASH = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function collect(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks)
}

function unwrap(result) {
  assert.equal(result.status, 'success', JSON.stringify(result))
  return result.value
}

async function setup(
  t,
  contents = [Buffer.alloc(0), Buffer.from('测试存档'), Buffer.alloc(131073, 17)],
  options = {},
) {
  const temporaryRoot = await realpath(tmpdir())
  const base = await mkdtemp(join(temporaryRoot, 'savedata-archive-test-'))
  const cleanup = { archive: null }
  t.after(async () => {
    if (cleanup.archive) await cleanup.archive.retryCleanup()
    const child = relative(temporaryRoot, base)
    assert.ok(
      child &&
        child !== '..' &&
        !child.startsWith(`..${sep}`) &&
        !isAbsolute(child) &&
        base.includes('savedata-archive-test-'),
    )
    await rm(base, { recursive: true, force: true })
  })
  const root = join(base, '源 存档')
  const privateDirectory = join(base, 'private')
  await mkdir(root)
  await mkdir(privateDirectory)
  const source = await createDirectoryAdapter(join(base, 'control', 'directories.json'))
  const names = contents.map((content, index) => `存档 😀 ${index}.sav`)
  for (const [index, content] of contents.entries())
    await writeFile(join(root, names[index]), content)
  const selected = unwrap(await source.registerDirectory(root))
  const listing = unwrap(await source.listDirectory(selected.rootId))
  const entries = names.map((name) => listing.entries.find((entry) => entry.name === name))
  const request = {
    protocolVersion: 1,
    transferId: 'test-batch',
    sourceRootId: selected.rootId,
    files: entries.map((entry, index) => ({
      fileId: `f${String(index + 1).padStart(6, '0')}`,
      entryId: entry.entryId,
    })),
  }
  const archive = await createWindowsArchiveAdapter(source, privateDirectory, options)
  cleanup.archive = archive
  return {
    base,
    root,
    privateDirectory,
    source,
    archive,
    request,
    names,
    contents,
    cacheRoot: join(privateDirectory, 'transfer-archives-v1'),
  }
}

function fromArchive(bytes, manifest = FIXTURE.manifest) {
  return {
    ...structuredClone(manifest),
    archive: { ...manifest.archive, sizeBytes: bytes.length, sha256: HASH(bytes) },
  }
}

async function expectFailure(archive, bytes, code, manifest = fromArchive(bytes)) {
  const input = Readable.from([bytes])
  await assert.rejects(
    archive.receive(manifest, input),
    (error) => error instanceof ArchiveError && error.operationError.code === code,
  )
  assert.equal(input.destroyed, true)
}

test('源快照与原生 gzip1 往返保留内容/mtime，空文件和超过缓冲区的数据都实际读取', async (t) => {
  const fixture = await setup(t)
  const before = await Promise.all(fixture.names.map((name) => stat(join(fixture.root, name))))
  const prepared = await fixture.archive.prepare(fixture.request)
  assert.equal(Object.isFrozen(prepared.manifest), true)
  const bytes = await collect(await prepared.openArchive())
  assert.equal(HASH(bytes), prepared.manifest.archive.sha256)
  assert.equal(bytes.length, prepared.manifest.archive.sizeBytes)
  assert.equal(gunzipSync(bytes).length, prepared.manifest.archive.tarSizeBytes)
  const manifest = prepared.manifest
  await prepared.dispose()
  const progress = []
  const received = await fixture.archive.receive(manifest, Readable.from([bytes]), {
    onProgress: (value) => progress.push(value),
  })
  for (const [index, file] of manifest.files.entries())
    assert.deepEqual(await collect(await received.openFile(file.fileId)), fixture.contents[index])
  await received.dispose()
  for (const [index, name] of fixture.names.entries()) {
    assert.deepEqual(await readFile(join(fixture.root, name)), fixture.contents[index])
    const after = await stat(join(fixture.root, name))
    assert.equal(after.mtimeMs, before[index].mtimeMs)
    assert.equal(after.ino, before[index].ino)
  }
  assert.deepEqual(await readdir(fixture.cacheRoot), ['cache-root.json'])
  assert.ok(progress.length > 0)
})

test('解码独立 Python 固定夹具，编码结果解压后匹配独立预期 tar，不能只自我往返', async (t) => {
  const contents = FIXTURE.contentsBase64.map((value) => Buffer.from(value, 'base64'))
  const { archive, request } = await setup(t, contents)
  const received = await archive.receive(
    FIXTURE.manifest,
    Readable.from([Buffer.from(FIXTURE.archiveBase64, 'base64')]),
  )
  for (const [index, file] of FIXTURE.manifest.files.entries())
    assert.deepEqual(await collect(await received.openFile(file.fileId)), contents[index])
  await received.dispose()
  const prepared = await archive.prepare(request)
  const bytes = await collect(await prepared.openArchive())
  assert.deepEqual(gunzipSync(bytes), Buffer.from(FIXTURE.tarBase64, 'base64'))
  await prepared.dispose()
})

test('缓存句柄独占任务，未关闭读流不能清理，释放后可复用且不接受跨任务文件 ID', async (t) => {
  const { archive, request } = await setup(t, [Buffer.from('abc')])
  const artifact = await archive.prepare(request)
  await assert.rejects(archive.prepare(request), (error) => error.operationError.code === 'busy')
  await assert.rejects(
    artifact.openFile('f000002'),
    (error) => error.operationError.code === 'invalid-request',
  )
  const stream = await artifact.openArchive()
  await assert.rejects(artifact.dispose(), (error) => error.operationError.code === 'busy')
  await collect(stream)
  await Promise.all([artifact.dispose(), artifact.dispose()])
  await artifact.dispose()
  await assert.rejects(
    artifact.openArchive(),
    (error) => error.operationError.code === 'task-conflict',
  )
  const next = await archive.prepare(request)
  await next.dispose()
})

test('归档成员的穿越、绝对路径、重复、类型/扩展、属主和非规范字段均被拒绝', async (t) => {
  const { archive, cacheRoot } = await setup(t)
  const tar = Buffer.from(FIXTURE.tarBase64, 'base64')
  const variants = [
    (value) => {
      value.fill(0, 0, 100)
      value.write('../outside', 0)
    },
    (value) => {
      value.fill(0, 0, 100)
      value.write('/outside', 0)
    },
    (value) => {
      value.write('f000001', 512)
    },
    ...['1', '2', '5', 'x', 'L', 'S'].map((flag) => (value) => {
      value[156] = flag.charCodeAt(0)
    }),
    (value) => {
      value[124] = 128
    },
    (value) => {
      value.write('0000001\0', 108)
    },
    (value) => {
      value.write('someone', 265)
    },
    (value) => {
      value.write('../prefix', 345)
    },
    (value) => {
      value[511] = 1
    },
  ]
  for (const change of variants) {
    const altered = Buffer.from(tar)
    change(altered)
    // 与生产编码器独立计算 checksum，确保不是仅凭校验和不符而拒绝。
    const offset = altered.subarray(512, 519).toString() === 'f000001' ? 512 : 0
    altered.fill(32, offset + 148, offset + 156)
    const checksum = altered.subarray(offset, offset + 512).reduce((sum, byte) => sum + byte, 0)
    altered.write(checksum.toString(8).padStart(6, '0') + '\0 ', offset + 148)
    await expectFailure(archive, gzipSync(altered, { level: 1 }), 'invalid-archive')
    assert.deepEqual(await readdir(cacheRoot), ['cache-root.json'])
  }
})

test('tar 校验头、成员遗漏/乱序、非零填充、结束截断和额外结束记录均失败', async (t) => {
  const { archive } = await setup(t)
  const original = Buffer.from(FIXTURE.tarBase64, 'base64')
  const badChecksum = Buffer.from(original)
  badChecksum[148] ^= 1
  const badPadding = Buffer.from(original)
  badPadding[1024 + FIXTURE.manifest.files[1].sizeBytes] = 1
  const badEnd = Buffer.from(original)
  badEnd[badEnd.length - 1] = 1
  const wrongOrder = Buffer.from(original)
  original.copy(wrongOrder, 0, 512, 1024)
  const missing = Buffer.concat([original.subarray(0, 512), original.subarray(1536)])
  for (const tar of [
    badChecksum,
    badPadding,
    badEnd,
    wrongOrder,
    missing,
    original.subarray(0, original.length - 512),
    Buffer.concat([original, Buffer.alloc(512)]),
    Buffer.concat([original.subarray(0, -1024), original.subarray(0, 512), Buffer.alloc(1024)]),
  ])
    await expectFailure(archive, gzipSync(tar, { level: 1 }), 'invalid-archive')
})

test('gzip 严格拒绝可选头、拼接成员、尾随、截断和 CRC/ISIZE 错误，即使压缩体哈希更新', async (t) => {
  const { archive } = await setup(t)
  const original = Buffer.from(FIXTURE.archiveBase64, 'base64')
  const flags = Buffer.from(original)
  flags[3] = 8
  const time = Buffer.from(original)
  time[4] = 1
  const crc = Buffer.from(original)
  crc[crc.length - 8] ^= 1
  const size = Buffer.from(original)
  size[size.length - 4] ^= 1
  for (const bytes of [
    flags,
    time,
    crc,
    size,
    Buffer.concat([original, original]),
    Buffer.concat([original, Buffer.from('trailing')]),
    Buffer.concat([original, Buffer.alloc(8)]),
    original.subarray(0, -4),
    gzipSync(Buffer.alloc(0)),
  ])
    await expectFailure(archive, bytes, 'invalid-archive')
})

test('压缩体/文件长度和 SHA-256 逐层验证，失败后没有可发布缓存句柄', async (t) => {
  const { archive, cacheRoot } = await setup(t)
  const bytes = Buffer.from(FIXTURE.archiveBase64, 'base64')
  const wrongArchiveHash = structuredClone(FIXTURE.manifest)
  wrongArchiveHash.archive.sha256 = 'a'.repeat(64)
  await expectFailure(archive, bytes, 'checksum-mismatch', wrongArchiveHash)
  const wrongFileHash = structuredClone(FIXTURE.manifest)
  wrongFileHash.files[1].sha256 = 'a'.repeat(64)
  await expectFailure(archive, bytes, 'checksum-mismatch', wrongFileHash)
  for (const delta of [-1, 1]) {
    const wrongLength = structuredClone(FIXTURE.manifest)
    wrongLength.archive.sizeBytes += delta
    await expectFailure(archive, bytes, 'checksum-mismatch', wrongLength)
  }
  assert.deepEqual(await readdir(cacheRoot), ['cache-root.json'])
})

test('收紧的成员/总原文/tar/压缩体/私有缓存硬限在实际流中执行，不能由清单放宽', async (t) => {
  const fixture = await setup(t, [Buffer.alloc(17, 65)])
  for (const quota of [
    { maxFileBytes: 16 },
    { maxTotalFileBytes: 16 },
    { maxTarBytes: 1536 },
    { maxArchiveBytes: 20 },
    { maxCacheBytes: 1 },
  ]) {
    const archive = await createWindowsArchiveAdapter(fixture.source, fixture.privateDirectory, {
      quota,
    })
    await assert.rejects(
      archive.prepare(fixture.request),
      (error) => error.operationError.code === 'resource-limit',
    )
    await archive.retryCleanup()
    assert.deepEqual(await readdir(fixture.cacheRoot), ['cache-root.json'])
  }
  const archive = await createWindowsArchiveAdapter(fixture.source, fixture.privateDirectory, {
    quota: { maxTarBytes: FIXTURE.manifest.archive.tarSizeBytes },
  })
  const bomb = gzipSync(Buffer.alloc(1024 * 1024), { level: 1 })
  await expectFailure(archive, bomb, 'resource-limit')
})

test('实际字节等于各项收紧上限时允许，超 1 个缓存字节即拒绝', async (t) => {
  const fixture = await setup(t, [Buffer.alloc(17, 65)])
  const prepared = await fixture.archive.prepare(fixture.request)
  const bytes = await collect(await prepared.openArchive())
  const manifest = prepared.manifest
  const [jobName] = (await readdir(fixture.cacheRoot)).filter((name) => name.startsWith('job-'))
  const cacheBytes = (
    await Promise.all(
      (await readdir(join(fixture.cacheRoot, jobName))).map((name) =>
        stat(join(fixture.cacheRoot, jobName, name)),
      ),
    )
  ).reduce((sum, value) => sum + value.size, 0)
  await prepared.dispose()
  const quota = {
    maxFileBytes: 17,
    maxTotalFileBytes: 17,
    maxTarBytes: manifest.archive.tarSizeBytes,
    maxArchiveBytes: bytes.length,
    maxCacheBytes: cacheBytes,
  }
  const exact = await createWindowsArchiveAdapter(fixture.source, fixture.privateDirectory, {
    quota,
  })
  const next = await exact.prepare(fixture.request)
  await next.dispose()
  const received = await exact.receive(manifest, Readable.from([bytes]))
  await received.dispose()
  const over = await createWindowsArchiveAdapter(fixture.source, fixture.privateDirectory, {
    quota: { ...quota, maxCacheBytes: cacheBytes - 1 },
  })
  await assert.rejects(
    over.prepare(fixture.request),
    (error) => error.operationError.code === 'resource-limit',
  )
})

test('空间检查失败、写入错误和中断均保留稳定错误且释放任务', async (t) => {
  const fixture = await setup(t, [Buffer.from('data')])
  const archive = await createWindowsArchiveAdapter(fixture.source, fixture.privateDirectory, {
    io: { availableBytes: async () => 0n },
  })
  await assert.rejects(
    archive.prepare(fixture.request),
    (error) => error.operationError.code === 'insufficient-space',
  )
  const input = new Readable({
    read() {
      this.destroy(new Error('synthetic input failure'))
    },
  })
  await assert.rejects(
    fixture.archive.receive(FIXTURE.manifest, input),
    (error) => error.operationError.code === 'io-failure',
  )
  assert.equal(input.destroyed, true)
  const result = await fixture.archive.prepare(fixture.request)
  await result.dispose()
})

test('源内容读取后的可观察变化被拒绝，归档模块不会写回源', async (t) => {
  const fixture = await setup(t, [Buffer.from('source')])
  let changed = false
  await assert.rejects(
    fixture.archive.prepare(fixture.request, {
      onProgress(value) {
        if (value.sourceBytesRead > 0 && !changed) {
          changed = true
          writeFileSync(join(fixture.root, fixture.names[0]), 'changed source')
        }
      },
    }),
    (error) => error.operationError.code === 'source-changed',
  )
  assert.equal(await readFile(join(fixture.root, fixture.names[0]), 'utf8'), 'changed source')
  assert.deepEqual(await readdir(fixture.cacheRoot), ['cache-root.json'])
})

test('未知源长度按实际流计数，短于已知长度或实际超限不生成归档', async (t) => {
  const fixture = await setup(t, [Buffer.from('abc')])
  let known = null
  const fake = {
    deviceId: fixture.source.deviceId,
    assertCacheIsolated: (path) => fixture.source.assertCacheIsolated(path),
    openFile: async (reference) => {
      const value = unwrap(await fixture.source.openFile(reference))
      value.stream.destroy()
      return {
        status: 'success',
        value: {
          ...value,
          metadata: { ...value.metadata, sizeBytes: known },
          stream: Readable.from([Buffer.from('abc')]),
          verifyUnchanged: async () => {},
        },
      }
    },
  }
  const archive = await createWindowsArchiveAdapter(fake, fixture.privateDirectory)
  const actual = await archive.prepare(fixture.request)
  assert.equal(actual.manifest.files[0].sizeBytes, 3)
  await actual.dispose()
  known = 4
  await assert.rejects(
    archive.prepare(fixture.request),
    (error) => error.operationError.code === 'source-changed',
  )
  known = null
  const small = await createWindowsArchiveAdapter(fake, fixture.privateDirectory, {
    quota: { maxFileBytes: 2 },
  })
  await assert.rejects(
    small.prepare(fixture.request),
    (error) => error.operationError.code === 'resource-limit',
  )
})

test('取消源读取或接收时关闭流并清理，预先超时与用户取消分开', async (t) => {
  const fixture = await setup(t, [Buffer.alloc(100000, 65)])
  const controller = new AbortController()
  await assert.rejects(
    fixture.archive.prepare(fixture.request, {
      signal: controller.signal,
      onProgress() {
        controller.abort()
      },
    }),
    ArchiveCancelledError,
  )
  const receiving = new AbortController()
  const input = new Readable({
    read() {
      this.push(Buffer.from(FIXTURE.archiveBase64, 'base64'))
      this._read = () => {}
    },
  })
  await assert.rejects(
    fixture.archive.receive(FIXTURE.manifest, input, {
      signal: receiving.signal,
      onProgress() {
        receiving.abort()
      },
    }),
    ArchiveCancelledError,
  )
  assert.equal(input.destroyed, true)
  const timed = AbortSignal.abort(new DOMException('synthetic deadline', 'TimeoutError'))
  await assert.rejects(
    fixture.archive.prepare(fixture.request, { signal: timed }),
    (error) => error.operationError.code === 'timeout',
  )
  assert.deepEqual(await readdir(fixture.cacheRoot), ['cache-root.json'])
})

test('清理失败保留所有权并阻止新任务，重试成功后才恢复', async (t) => {
  const fixture = await setup(t, [Buffer.from('abc')])
  let shouldFail = true
  const archive = await createWindowsArchiveAdapter(fixture.source, fixture.privateDirectory, {
    io: {
      unlinkFile: async (path) => {
        if (shouldFail) throw new Error('synthetic cleanup failure')
        await unlink(path)
      },
    },
  })
  const artifact = await archive.prepare(fixture.request)
  const failures = await Promise.allSettled([artifact.dispose(), artifact.dispose()])
  assert.equal(
    failures.every(
      (result) =>
        result.status === 'rejected' &&
        result.reason instanceof ArchiveError &&
        result.reason.operationError.code === 'cleanup-failed',
    ),
    true,
  )
  await assert.rejects(
    archive.prepare(fixture.request),
    (error) => error.operationError.code === 'busy',
  )
  shouldFail = false
  await archive.retryCleanup()
  const next = await archive.prepare(fixture.request)
  await next.dispose()
})

test('取消或失败的原始结果不会被后续清理失败覆盖', async (t) => {
  const fixture = await setup(t, [Buffer.from('abc')])
  let shouldFail = true
  const archive = await createWindowsArchiveAdapter(fixture.source, fixture.privateDirectory, {
    quota: { maxFileBytes: 2 },
    io: {
      unlinkFile: async (path) => {
        if (shouldFail) throw new Error('synthetic cleanup failure')
        await unlink(path)
      },
    },
  })
  await assert.rejects(
    archive.prepare(fixture.request),
    (error) =>
      error.operationError.code === 'resource-limit' &&
      error.cleanupError.code === 'cleanup-failed',
  )
  shouldFail = false
  await archive.retryCleanup()
  const controller = new AbortController()
  shouldFail = true
  const cancelling = await createWindowsArchiveAdapter(fixture.source, fixture.privateDirectory, {
    io: {
      unlinkFile: async (path) => {
        if (shouldFail) throw new Error('synthetic cleanup failure')
        await unlink(path)
      },
    },
  })
  await assert.rejects(
    cancelling.prepare(fixture.request, {
      signal: controller.signal,
      onProgress() {
        controller.abort()
      },
    }),
    (error) =>
      error instanceof ArchiveCancelledError && error.cleanupError.code === 'cleanup-failed',
  )
  shouldFail = false
  await cancelling.retryCleanup()
})

test('应用启动仅清理匹配所有权的孤儿缓存，不恢复旧任务', async (t) => {
  const fixture = await setup(t)
  const marker = JSON.parse(await readFile(join(fixture.cacheRoot, 'cache-root.json'), 'utf8'))
  const jobId = '11111111-1111-4111-8111-111111111111'
  const job = join(fixture.cacheRoot, `job-${jobId}`)
  await mkdir(job)
  await writeFile(join(job, 'job.json'), JSON.stringify({ ownerId: marker.ownerId, jobId }))
  await writeFile(join(job, 'raw-f000001'), 'orphan')
  await createWindowsArchiveAdapter(fixture.source, fixture.privateDirectory)
  assert.deepEqual(await readdir(fixture.cacheRoot), ['cache-root.json'])
})

test('外来标记、陌生文件或链接越界均失败关闭，不删除外部内容', async (t) => {
  const fixture = await setup(t)
  const jobId = '22222222-2222-4222-8222-222222222222'
  const job = join(fixture.cacheRoot, `job-${jobId}`)
  await mkdir(job)
  await writeFile(join(job, 'job.json'), JSON.stringify({ ownerId: 'another-owner', jobId }))
  await writeFile(join(job, 'raw-f000001'), 'foreign')
  await assert.rejects(
    createWindowsArchiveAdapter(fixture.source, fixture.privateDirectory),
    (error) => error.operationError.code === 'cleanup-failed',
  )
  assert.equal(await readFile(join(job, 'raw-f000001'), 'utf8'), 'foreign')
  const marker = JSON.parse(await readFile(join(fixture.cacheRoot, 'cache-root.json'), 'utf8'))
  await writeFile(join(job, 'job.json'), JSON.stringify({ ownerId: marker.ownerId, jobId }))
  await symlink(fixture.root, join(job, 'file-f000002'), 'junction')
  await assert.rejects(
    createWindowsArchiveAdapter(fixture.source, fixture.privateDirectory),
    (error) => error.operationError.code === 'cleanup-failed',
  )
  assert.deepEqual(await readFile(join(fixture.root, fixture.names[1])), fixture.contents[1])
})

test('缓存不得写入任何已登记源根，工厂检查发生在创建子目录之前', async (t) => {
  const fixture = await setup(t)
  await assert.rejects(
    createWindowsArchiveAdapter(fixture.source, fixture.root),
    (error) => error.operationError.code === 'path-outside-root',
  )
  assert.equal((await readdir(fixture.root)).includes('transfer-archives-v1'), false)
})

test('大块原始输入拆为有限缓冲，解包校验进度与文件数真实递增', async (t) => {
  const noise = Buffer.alloc(200000)
  let seed = 0x12345678
  for (let index = 0; index < noise.length; index++) {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    noise[index] = seed & 255
  }
  const contents = [noise]
  const fixture = await setup(t, contents)
  const prepared = await fixture.archive.prepare(fixture.request)
  const manifest = prepared.manifest
  const bytes = await collect(await prepared.openArchive())
  assert.ok(bytes.length > 65536)
  await prepared.dispose()
  const progress = []
  const received = await fixture.archive.receive(manifest, Readable.from([bytes]), {
    onProgress: (value) => progress.push(value),
  })
  assert.equal(progress.at(-1).verifiedFiles, 1)
  assert.equal(progress.at(-1).verifiedFileBytes, 200000)
  for (let index = 1; index < progress.length; index++) {
    assert.ok(progress[index].verifiedFileBytes >= progress[index - 1].verifiedFileBytes)
    assert.ok(progress[index].verifiedFileBytes - progress[index - 1].verifiedFileBytes <= 65536)
    assert.ok(progress[index].archiveBytesStored - progress[index - 1].archiveBytesStored <= 65536)
  }
  assert.deepEqual(await collect(await received.openFile('f000001')), contents[0])
  await received.dispose()
})

test('解包中途取消关闭原生流并清理全部本次原文，不留下成功句柄', async (t) => {
  const fixture = await setup(t)
  const controller = new AbortController()
  await assert.rejects(
    fixture.archive.receive(
      FIXTURE.manifest,
      Readable.from([Buffer.from(FIXTURE.archiveBase64, 'base64')]),
      {
        signal: controller.signal,
        onProgress(value) {
          if (value.verifiedFiles > 0) controller.abort()
        },
      },
    ),
    ArchiveCancelledError,
  )
  assert.deepEqual(await readdir(fixture.cacheRoot), ['cache-root.json'])
})
