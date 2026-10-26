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
import { request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { gzipSync } from 'node:zlib'
import test from 'node:test'
import { BATCH_LIMITS, isBatchState, matchesBatchState } from '@savedata-sync/shared'
import { createDirectoryAdapter } from '../src/main/directory-adapter.ts'
import { createWindowsArchiveAdapter } from '../src/main/archive-adapter.ts'
import { WindowsNewFilePublisher } from '../src/main/new-file-publisher.ts'
import { WindowsHttpService } from '../src/main/http-service.ts'

const FIXTURE = JSON.parse(
  await readFile(new URL('./fixtures/archive-v1.json', import.meta.url), 'utf8'),
)
const HASH = (value) => createHash('sha256').update(value).digest('hex')
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const unwrap = (result) => {
  assert.equal(result.status, 'success', JSON.stringify(result))
  return result.value
}

async function setup(t, options = {}) {
  const temporaryRoot = await realpath(tmpdir())
  const base = await mkdtemp(join(temporaryRoot, 'savedata-receiver-test-'))
  const root = join(base, '专用接收目录')
  const sourceRoot = join(base, '只读源')
  const privateDirectory = join(base, 'private')
  await mkdir(root)
  await mkdir(sourceRoot)
  await mkdir(privateDirectory)
  const original = join(sourceRoot, 'original.sav')
  await writeFile(original, '不得修改的合成源')
  const before = await lstat(original, { bigint: true })
  const source = await createDirectoryAdapter(join(base, 'control', 'directories.json'))
  const selected = unwrap(await source.registerDirectory(root))
  unwrap(await source.registerDirectory(sourceRoot))
  const archive = await createWindowsArchiveAdapter(
    source,
    privateDirectory,
    options.archiveOptions,
  )
  const publisher = new WindowsNewFilePublisher(source, options.publisherOptions)
  if (options.grant !== false) {
    await publisher.grant(selected.rootId)
  }
  const provider = options.wrapPublisher ? options.wrapPublisher(publisher) : publisher
  const service = new WindowsHttpService(
    source,
    options.wrapArchive ? options.wrapArchive(archive) : archive,
    { ...options.serviceOptions, publisher: provider },
  )
  const address = await service.start()
  t.after(async () => {
    await service.stop()
    await publisher.stop()
    assert.equal(await readFile(original, 'utf8'), '不得修改的合成源')
    const after = await lstat(original, { bigint: true })
    for (const field of ['size', 'mtimeNs', 'ctimeNs', 'dev', 'ino']) {
      assert.equal(after[field], before[field])
    }
    const child = relative(temporaryRoot, base)
    assert.ok(
      child &&
        child !== '..' &&
        !child.startsWith(`..${sep}`) &&
        !isAbsolute(child) &&
        base.includes('savedata-receiver-test-'),
    )
    await rm(base, { recursive: true, force: true })
  })
  const payload = (count = 3, id = 'upload-1') => {
    const manifest = structuredClone(FIXTURE.manifest)
    manifest.transferId = id
    manifest.files = manifest.files.slice(0, count)
    manifest.totalFileBytes = manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0)
    const end = manifest.files.reduce(
      (sum, file) => sum + 512 + Math.ceil(file.sizeBytes / 512) * 512,
      0,
    )
    const tar = Buffer.concat([
      Buffer.from(FIXTURE.tarBase64, 'base64').subarray(0, end),
      Buffer.alloc(1024),
    ])
    const bytes = gzipSync(tar, { level: 1 })
    manifest.archive = {
      ...manifest.archive,
      sizeBytes: bytes.length,
      sha256: HASH(bytes),
      tarSizeBytes: tar.length,
    }
    const names = ['空 文件.sav', '100% 存档.sav', '较大文件.sav']
    const request = {
      protocolVersion: 1,
      manifest,
      targetRootId: selected.rootId,
      targets: manifest.files.map((file, index) => ({
        fileId: file.fileId,
        parentId: null,
        name: names[index],
      })),
    }
    return { request, bytes, tar }
  }
  return {
    base,
    root,
    source,
    archive,
    publisher,
    service,
    address,
    selected,
    payload,
    cacheRoot: join(privateDirectory, 'transfer-archives-v1'),
  }
}

function request(fixture, path, options = {}) {
  const body =
    options.body ??
    (options.value === undefined ? null : Buffer.from(JSON.stringify(options.value)))
  const headers = {
    'x-sync-session-id': fixture.address.sessionId,
    ...(body ? { 'content-length': body.length, 'content-type': 'application/json' } : {}),
    ...options.headers,
  }
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      delete headers[key]
    }
  }
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: '127.0.0.1',
        port: fixture.address.port,
        path,
        method: options.method ?? 'GET',
        headers,
        agent: false,
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.once('error', reject)
        response.once('end', () => {
          const bytes = Buffer.concat(chunks)
          resolve({
            status: response.statusCode,
            headers: response.headers,
            bytes,
            json: bytes.length ? JSON.parse(bytes.toString('utf8')) : null,
          })
        })
      },
    )
    outgoing.once('error', reject)
    outgoing.setTimeout(5000, () => outgoing.destroy(new Error('测试 HTTP 超时')))
    outgoing.end(body)
  })
}

async function register(fixture, payload) {
  return request(fixture, '/v1/transfers/uploads', { method: 'POST', value: payload.request })
}

function upload(fixture, payload, options = {}) {
  return request(fixture, `/v1/transfers/${payload.request.manifest.transferId}/content`, {
    method: 'PUT',
    body: payload.bytes,
    ...options,
    headers: {
      'content-type': 'application/gzip',
      'content-length': payload.bytes.length,
      'x-archive-sha256': payload.request.manifest.archive.sha256,
      ...options.headers,
    },
  })
}

async function waitState(fixture, payload, predicate = (state) => state.status !== 'running') {
  for (let index = 0; index < 300; index++) {
    const response = await request(fixture, `/v1/transfers/${payload.request.manifest.transferId}`)
    assert.equal(response.status, 200)
    const state = unwrap(response.json)
    assert.ok(isBatchState(state), JSON.stringify(state))
    assert.ok(
      matchesBatchState(state, payload.request.manifest, 'android-to-windows', payload.request),
      JSON.stringify(state),
    )
    if (predicate(state)) {
      return state
    }
    await sleep(5)
  }
  assert.fail('接收任务未在测试期限内完成')
}

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function waitGate(gate, signal) {
  if (signal.aborted) {
    return
  }
  let abort
  const aborted = new Promise((resolve) => {
    abort = resolve
    signal.addEventListener('abort', abort, { once: true })
  })
  try {
    await Promise.race([gate.promise, aborted])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

test('201 只登记 awaiting-content；202 只确认压缩体，最终逐项创建并回读全部文件', async (t) => {
  const fixture = await setup(t)
  const payload = fixture.payload()
  const device = unwrap((await request(fixture, '/v1/device')).json)
  assert.equal(device.device.capabilities.canReceiveFiles, 'supported')
  const created = await register(fixture, payload)
  assert.equal(created.status, 201)
  assert.equal(unwrap(created.json).stage, 'awaiting-content')
  assert.deepEqual(await readdir(fixture.root), [])
  const accepted = await upload(fixture, payload)
  assert.equal(accepted.status, 202)
  assert.equal(unwrap(accepted.json).status, 'running')
  assert.equal(unwrap(accepted.json).stage, 'verifying')
  assert.equal(accepted.headers['cache-control'], 'no-store')
  const terminal = await waitState(fixture, payload)
  assert.equal(terminal.status, 'succeeded')
  assert.equal(terminal.cleanupStatus, 'complete')
  assert.equal(terminal.fileResults.length, 3)
  for (const [index, result] of terminal.fileResults.entries()) {
    assert.equal(result.status, 'succeeded')
    assert.deepEqual(
      await readFile(join(fixture.root, result.entry.name)),
      Buffer.from(FIXTURE.contentsBase64[index], 'base64'),
    )
  }
  assert.deepEqual(await readdir(fixture.cacheRoot), ['cache-root.json'])
})

test('PUT 内容头必须匹配，非法头不领取内容，正确请求仍可单次完成', async (t) => {
  const fixture = await setup(t)
  const payload = fixture.payload()
  assert.equal((await register(fixture, payload)).status, 201)
  for (const headers of [
    { 'content-type': 'text/plain' },
    { 'x-archive-sha256': undefined },
    { 'x-archive-sha256': '0'.repeat(64) },
    { 'content-length': BATCH_LIMITS.maxArchiveBytes + 1 },
    { 'content-encoding': 'gzip' },
    { range: 'bytes=0-1' },
  ]) {
    const result = await upload(fixture, payload, { headers })
    assert.ok([400, 413, 422].includes(result.status), JSON.stringify(result))
  }
  assert.equal((await upload(fixture, payload)).status, 202)
  assert.equal((await waitState(fixture, payload)).status, 'succeeded')
  assert.equal((await upload(fixture, payload)).json.error.code, 'task-conflict')
  assert.equal(
    (await request(fixture, '/v1/transfers/upload-1/content')).json.error.code,
    'task-conflict',
  )
})

test('第 k 项出现真实竞争时保留前项成功，后项未尝试，既有竞争内容不变', async (t) => {
  const fixture = await setup(t, {
    publisherOptions: {
      io: {
        link: async (candidate, target) => {
          if (basename(target) === '100% 存档.sav') {
            await writeFile(target, '竞争文件', { flag: 'wx' })
          }
          await link(candidate, target)
        },
      },
    },
  })
  const payload = fixture.payload()
  await register(fixture, payload)
  await upload(fixture, payload)
  const terminal = await waitState(fixture, payload)
  assert.equal(terminal.status, 'failed')
  assert.deepEqual(
    terminal.fileResults.map((result) => result.status),
    ['succeeded', 'failed', 'not-attempted'],
  )
  assert.equal(terminal.fileResults[1].error.code, 'name-conflict')
  assert.equal(terminal.fileResults[2].reason, 'prior-failure')
  assert.equal(await readFile(join(fixture.root, '100% 存档.sav'), 'utf8'), '竞争文件')
  assert.equal((await lstat(join(fixture.root, '空 文件.sav'))).size, 0)
  assert.ok(!(await readdir(fixture.root)).includes('较大文件.sav'))
})

test('第 k 项取消保留前项已确认成功，当前取消与后项未尝试分别反馈', async (t) => {
  const entered = deferred()
  const gate = deferred()
  const fixture = await setup(t, {
    wrapPublisher: (publisher) => ({
      checkTarget: publisher.checkTarget.bind(publisher),
      retryCleanup: publisher.retryCleanup.bind(publisher),
      publish: async (file, input, options) => {
        if (file.fileId === 'f000002') {
          entered.resolve()
          await waitGate(gate, options.signal)
        }
        return publisher.publish(file, input, options)
      },
    }),
  })
  const payload = fixture.payload()
  try {
    await register(fixture, payload)
    await upload(fixture, payload)
    await entered.promise
    await request(fixture, '/v1/transfers/upload-1', { method: 'DELETE' })
    const terminal = await waitState(fixture, payload)
    assert.equal(terminal.status, 'cancelled')
    assert.deepEqual(
      terminal.fileResults.map((result) => result.status),
      ['succeeded', 'cancelled', 'not-attempted'],
    )
    assert.equal(terminal.fileResults[2].reason, 'cancelled')
    assert.deepEqual(await readdir(fixture.root), ['空 文件.sav'])
  } finally {
    gate.resolve()
  }
})

test('完整数据收齐后响应丢失不会取消发布，重查能取得真实终态', async (t) => {
  const stored = deferred()
  const fixture = await setup(t, {
    wrapArchive: (archive) => ({
      prepare: archive.prepare.bind(archive),
      retryCleanup: archive.retryCleanup.bind(archive),
      receive: (manifest, input, options) =>
        archive.receive(manifest, input, {
          ...options,
          onArchiveStored: () => {
            options.onArchiveStored()
            stored.resolve()
          },
        }),
    }),
  })
  const payload = fixture.payload()
  await register(fixture, payload)
  const header = `PUT /v1/transfers/upload-1/content HTTP/1.1\r\nHost: localhost\r\nX-Sync-Session-Id: ${fixture.address.sessionId}\r\nContent-Type: application/gzip\r\nContent-Length: ${payload.bytes.length}\r\nX-Archive-Sha256: ${payload.request.manifest.archive.sha256}\r\n\r\n`
  const socket = connect({ host: '127.0.0.1', port: fixture.address.port }, () =>
    socket.write(Buffer.concat([Buffer.from(header), payload.bytes])),
  )
  socket.on('error', () => undefined)
  try {
    await stored.promise
    socket.destroy()
    assert.equal((await waitState(fixture, payload)).status, 'succeeded')
  } finally {
    socket.destroy()
  }
})

test('停止服务收尾待上传任务，重启更换会话且不会恢复旧接收', async (t) => {
  const fixture = await setup(t)
  const payload = fixture.payload()
  await register(fixture, payload)
  const previous = fixture.address
  await fixture.service.stop()
  fixture.address = await fixture.service.start({ port: previous.port })
  assert.notEqual(fixture.address.sessionId, previous.sessionId)
  assert.equal((await request(fixture, '/v1/transfers/upload-1')).json.error.code, 'result-unknown')
  assert.equal(
    (await request(fixture, '/v1/roots', { headers: { 'x-sync-session-id': previous.sessionId } }))
      .json.error.code,
    'session-mismatch',
  )
  assert.deepEqual(await readdir(fixture.root), [])
  assert.equal((await register(fixture, payload)).status, 201)
})
