import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { gzipSync, gunzipSync } from 'node:zlib'
import test from 'node:test'
import { createDesktopArchiveAdapter } from '../src/backend/archive-adapter.ts'
import { ArchiveCancelledError, ArchiveError } from '../src/backend/archive-errors.ts'
import { createDirectoryAdapter } from '../src/backend/directory-adapter.ts'

const FIXTURE = JSON.parse(
  await readFile(new URL('./fixtures/archive-v1.json', import.meta.url), 'utf8'),
)
/** 夹具清单里的成员，只取接收端用到的字段。 */
const FIXTURE_FILES = FIXTURE.manifest.files.map((file) => ({
  fileId: file.fileId,
  entryId: file.sourceEntryId,
  sizeBytes: file.sizeBytes,
  modifiedAt: null,
}))

async function collect(stream) {
  const chunks = []
  for await (const chunk of stream) {
    chunks.push(chunk)
  }
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
    if (cleanup.archive) {
      await cleanup.archive.retryCleanup()
    }
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
  for (const [index, content] of contents.entries()) {
    await writeFile(join(root, names[index]), content)
  }
  const selected = unwrap(await source.registerDirectory(root))
  const listing = unwrap(await source.listDirectory(selected.rootId))
  const files = names.map((name, index) => {
    const entry = listing.entries.find((item) => item.name === name)
    return {
      fileId: `f${String(index + 1).padStart(6, '0')}`,
      entryId: entry.entryId,
      sizeBytes: entry.sizeBytes,
      modifiedAt: entry.modifiedAt,
    }
  })
  const archive = await createDesktopArchiveAdapter(source, privateDirectory, options)
  cleanup.archive = archive
  return {
    root,
    rootId: selected.rootId,
    privateDirectory,
    source,
    archive,
    files,
    names,
    contents,
    cacheRoot: join(privateDirectory, 'transfer-archives-v1'),
  }
}

async function send(fixture, options) {
  const output = new PassThrough()
  const [bytes] = await Promise.all([
    collect(output),
    fixture.archive.sendFiles(fixture.rootId, fixture.files, output, options),
  ])
  return bytes
}

async function expectFailure(archive, bytes, code, files = FIXTURE_FILES) {
  const input = Readable.from([bytes])
  await assert.rejects(
    archive.receiveFiles(files, input),
    (error) => error instanceof ArchiveError && error.operationError.code === code,
  )
  assert.equal(input.destroyed, true)
}

test('边读边打包的 gzip1 往返保留内容，空文件和超过缓冲区的数据都实际读取，源文件不变', async (t) => {
  const fixture = await setup(t)
  const before = await Promise.all(fixture.names.map((name) => stat(join(fixture.root, name))))
  const sent = []
  const bytes = await send(fixture, { onBytes: (value) => sent.push(value) })
  const tarBytes = fixture.contents.reduce(
    (sum, content) => sum + 512 + Math.ceil(content.length / 512) * 512,
    1024,
  )
  assert.equal(gunzipSync(bytes).length, tarBytes)
  const received = []
  const staged = await fixture.archive.receiveFiles(fixture.files, Readable.from([bytes]), {
    onBytes: (value) => received.push(value),
  })
  for (const [index, file] of fixture.files.entries()) {
    assert.deepEqual(await collect(await staged.openFile(file.fileId)), fixture.contents[index])
  }
  await staged.dispose()
  for (const [index, name] of fixture.names.entries()) {
    assert.deepEqual(await readFile(join(fixture.root, name)), fixture.contents[index])
    const after = await stat(join(fixture.root, name))
    assert.equal(after.mtimeMs, before[index].mtimeMs)
    assert.equal(after.ino, before[index].ino)
  }
  assert.deepEqual(await readdir(fixture.cacheRoot), ['cache-root.json'])
  const total = fixture.contents.reduce((sum, content) => sum + content.length, 0)
  assert.equal(sent.at(-1), total)
  assert.equal(received.at(-1), total)
})

test('解码独立 Python 固定夹具，编码结果解压后匹配独立预期 tar，不能只自我往返', async (t) => {
  const contents = FIXTURE.contentsBase64.map((value) => Buffer.from(value, 'base64'))
  const fixture = await setup(t, contents)
  const staged = await fixture.archive.receiveFiles(
    FIXTURE_FILES,
    Readable.from([Buffer.from(FIXTURE.archiveBase64, 'base64')]),
  )
  for (const [index, file] of FIXTURE_FILES.entries()) {
    assert.deepEqual(await collect(await staged.openFile(file.fileId)), contents[index])
  }
  await staged.dispose()
  assert.deepEqual(gunzipSync(await send(fixture)), Buffer.from(FIXTURE.tarBase64, 'base64'))
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

test('gzip 严格拒绝可选头、拼接成员、尾随、截断和 CRC/ISIZE 错误', async (t) => {
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
  ]) {
    await expectFailure(archive, bytes, 'invalid-archive')
  }
})

test('收紧的成员、总原文、tar 和私有缓存上限在解包前或实际流中执行', async (t) => {
  const fixture = await setup(t, [Buffer.alloc(17, 65)])
  const bytes = await send(fixture)
  for (const quota of [
    { maxFileBytes: 16 },
    { maxTotalFileBytes: 16 },
    { maxTarBytes: 1536 },
    { maxCacheBytes: 16 },
  ]) {
    const archive = await createDesktopArchiveAdapter(fixture.source, fixture.privateDirectory, {
      quota,
    })
    await expectFailure(archive, bytes, 'resource-limit', fixture.files)
    await archive.retryCleanup()
    assert.deepEqual(await readdir(fixture.cacheRoot), ['cache-root.json'])
  }
})

test('源内容在发送期间的可观察变化被拒绝，归档模块不会写回源', async (t) => {
  const fixture = await setup(t, [Buffer.alloc(200000, 65)])
  let isChanged = false
  await assert.rejects(
    send(fixture, {
      onBytes() {
        if (!isChanged) {
          isChanged = true
          writeFileSync(join(fixture.root, fixture.names[0]), 'changed source')
        }
      },
    }),
    (error) => error.operationError.code === 'source-changed',
  )
  assert.equal(await readFile(join(fixture.root, fixture.names[0]), 'utf8'), 'changed source')
  assert.deepEqual(await readdir(fixture.cacheRoot), ['cache-root.json'])
})

test('取消接收时关闭流并清理，预先超时与用户取消分开', async (t) => {
  const fixture = await setup(t, [Buffer.alloc(100000, 65)])
  const bytes = await send(fixture)
  const receiving = new AbortController()
  const input = new Readable({
    read() {
      this.push(bytes)
      this._read = () => {}
    },
  })
  await assert.rejects(
    fixture.archive.receiveFiles(fixture.files, input, {
      signal: receiving.signal,
      onBytes() {
        receiving.abort()
      },
    }),
    ArchiveCancelledError,
  )
  assert.equal(input.destroyed, true)
  const timed = AbortSignal.abort(new DOMException('synthetic deadline', 'TimeoutError'))
  await assert.rejects(
    fixture.archive.receiveFiles(fixture.files, Readable.from([bytes]), { signal: timed }),
    (error) => error.operationError.code === 'timeout',
  )
  assert.deepEqual(await readdir(fixture.cacheRoot), ['cache-root.json'])
})
