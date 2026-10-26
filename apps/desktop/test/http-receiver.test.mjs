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
  unlink,
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
import { ArchiveCancelledError } from '../src/main/archive-errors.ts'

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
  if (options.grant !== false) await publisher.grant(selected.rootId)
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
    for (const field of ['size', 'mtimeNs', 'ctimeNs', 'dev', 'ino'])
      assert.equal(after[field], before[field])
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
  for (const [key, value] of Object.entries(headers)) if (value === undefined) delete headers[key]
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
    if (predicate(state)) return state
    await sleep(5)
  }
  assert.fail('接收任务未在测试期限内完成')
}

function raw(fixture, text) {
  return new Promise((resolve, reject) => {
    const chunks = []
    const socket = connect({ host: '127.0.0.1', port: fixture.address.port }, () =>
      socket.write(text),
    )
    socket.on('data', (chunk) => chunks.push(chunk))
    socket.once('error', (error) =>
      chunks.length ? resolve(Buffer.concat(chunks).toString('utf8')) : reject(error),
    )
    socket.once('close', () => resolve(Buffer.concat(chunks).toString('utf8')))
    socket.setTimeout(4000, () => socket.destroy(new Error('原始测试请求超时')))
  })
}

function changedArchive(payload, bytes) {
  return {
    ...payload,
    bytes,
    request: {
      ...payload.request,
      manifest: {
        ...payload.request.manifest,
        archive: {
          ...payload.request.manifest.archive,
          sizeBytes: bytes.length,
          sha256: HASH(bytes),
        },
      },
    },
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

test('读取登记不等于写授权，预检拒绝不占任务 ID，重新授权后可登记', async (t) => {
  const fixture = await setup(t, { grant: false })
  const payload = fixture.payload()
  assert.equal((await register(fixture, payload)).json.error.code, 'permission-denied')
  await fixture.publisher.grant(fixture.selected.rootId)
  assert.equal((await register(fixture, payload)).status, 201)
  assert.equal((await upload(fixture, payload)).status, 202)
  assert.equal((await waitState(fixture, payload)).status, 'succeeded')
})

test('预检拒绝已有目标与大小写等价映射，异步同 ID 登记只接纳一次', async (t) => {
  const fixture = await setup(t)
  const payload = fixture.payload()
  const same = structuredClone(payload.request)
  same.targets[1].name = same.targets[0].name.toUpperCase()
  assert.equal(
    (await request(fixture, '/v1/transfers/uploads', { method: 'POST', value: same })).json.error
      .code,
    'name-conflict',
  )
  const existing = join(fixture.root, payload.request.targets[0].name)
  await writeFile(existing, 'existing')
  assert.equal((await register(fixture, payload)).json.error.code, 'name-conflict')
  assert.equal(await readFile(existing, 'utf8'), 'existing')
  await unlink(existing)
  const results = await Promise.all([register(fixture, payload), register(fixture, payload)])
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409])
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

test('实际压缩体哈希不符不返回 202，失败状态与清理结果可查询', async (t) => {
  const fixture = await setup(t)
  const payload = fixture.payload()
  await register(fixture, payload)
  const bad = Buffer.from(payload.bytes)
  bad[10] ^= 1
  const response = await upload(fixture, payload, { body: bad })
  assert.equal(response.status, 422)
  const terminal = await waitState(fixture, payload)
  assert.equal(terminal.status, 'failed')
  assert.equal(terminal.error.code, 'checksum-mismatch')
  assert.ok(terminal.fileResults.every((result) => result.reason === 'batch-invalid'))
  assert.deepEqual(await readdir(fixture.root), [])
})

test('压缩体确认后 tar 末尾非法仍异步失败，全部文件校验前没有目标发布', async (t) => {
  let publications = 0
  const fixture = await setup(t, {
    wrapPublisher: (publisher) => ({
      checkTarget: (value) => publisher.checkTarget(value),
      retryCleanup: () => publisher.retryCleanup(),
      publish: async (...arguments_) => {
        publications++
        return publisher.publish(...arguments_)
      },
    }),
  })
  const payload = fixture.payload()
  const badTar = Buffer.from(payload.tar)
  badTar[badTar.length - 1] = 1
  const bad = changedArchive(payload, gzipSync(badTar, { level: 1 }))
  await register(fixture, bad)
  const accepted = await upload(fixture, bad)
  assert.equal(accepted.status, 202)
  assert.equal(accepted.json.value.stage, 'verifying')
  const terminal = await waitState(fixture, bad)
  assert.equal(terminal.status, 'failed')
  assert.equal(terminal.error.code, 'invalid-archive')
  assert.equal(publications, 0)
  assert.deepEqual(await readdir(fixture.root), [])
})

test('空文件仍实际创建；最终候选清理失败不推翻整批成功，并保留任务名额', async (t) => {
  const fault = { blocked: true }
  const fixture = await setup(t, {
    publisherOptions: {
      io: {
        unlink: async (path) => {
          if (fault.blocked) throw new Error('injected cleanup')
          await unlink(path)
        },
      },
    },
  })
  const payload = fixture.payload(1)
  try {
    await register(fixture, payload)
    await upload(fixture, payload)
    const terminal = await waitState(fixture, payload)
    assert.equal(terminal.status, 'succeeded')
    assert.equal(terminal.fileResults[0].bytesWritten, 0)
    assert.equal(terminal.cleanupStatus, 'incomplete')
    assert.equal((await register(fixture, fixture.payload(1, 'next'))).json.error.code, 'busy')
    fault.blocked = false
    await fixture.service.retryCleanup()
    assert.equal(
      (await request(fixture, '/v1/transfers/upload-1')).json.value.cleanupStatus,
      'complete',
    )
  } finally {
    fault.blocked = false
    await fixture.service.retryCleanup()
  }
})

test('第 k 项出现真实竞争时保留前项成功，后项未尝试，既有竞争内容不变', async (t) => {
  const fixture = await setup(t, {
    publisherOptions: {
      io: {
        link: async (candidate, target) => {
          if (basename(target) === '100% 存档.sav')
            await writeFile(target, '竞争文件', { flag: 'wx' })
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

test('等待内容到期失败，查询不续期；终态到期仍防重', async (t) => {
  const clock = { now: 1000 }
  const fixture = await setup(t, {
    serviceOptions: {
      now: () => clock.now,
      timeouts: { awaitingContent: 20, terminalRetention: 20 },
    },
  })
  const payload = fixture.payload()
  await register(fixture, payload)
  clock.now += 10
  assert.equal(
    (await request(fixture, '/v1/transfers/upload-1')).json.value.stage,
    'awaiting-content',
  )
  clock.now += 11
  const terminal = await waitState(fixture, payload)
  assert.equal(terminal.status, 'failed')
  assert.equal(terminal.error.code, 'timeout')
  clock.now += 21
  assert.equal((await request(fixture, '/v1/transfers/upload-1')).json.error.code, 'result-unknown')
  assert.equal((await register(fixture, payload)).json.error.code, 'task-conflict')
})

test('等待上传时取消立即收尾，重复 DELETE 返回终态且没有目标写入', async (t) => {
  const fixture = await setup(t)
  const payload = fixture.payload()
  await register(fixture, payload)
  assert.equal((await request(fixture, '/v1/transfers/upload-1', { method: 'DELETE' })).status, 202)
  const terminal = await waitState(fixture, payload)
  assert.equal(terminal.status, 'cancelled')
  assert.ok(terminal.fileResults.every((result) => result.reason === 'cancelled'))
  assert.equal((await request(fixture, '/v1/transfers/upload-1', { method: 'DELETE' })).status, 200)
  assert.deepEqual(await readdir(fixture.root), [])
})

test('原始 PUT 拒绝 chunked、重复头和编码体，不改变 awaiting-content', async (t) => {
  const fixture = await setup(t)
  const payload = fixture.payload()
  await register(fixture, payload)
  const session = `X-Sync-Session-Id: ${fixture.address.sessionId}\r\n`
  for (const extra of [
    'Transfer-Encoding: chunked\r\n',
    'Content-Length: 0\r\nContent-Length: 0\r\n',
    'Content-Length: 0\r\nContent-Encoding: gzip\r\n',
    `${session}Content-Length: 0\r\n`,
  ]) {
    assert.match(
      await raw(
        fixture,
        `PUT /v1/transfers/upload-1/content HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n${session}${extra}\r\n`,
      ),
      /^HTTP\/1\.1 400/,
    )
  }
  assert.equal(
    (await request(fixture, '/v1/transfers/upload-1')).json.value.stage,
    'awaiting-content',
  )
})

test('压缩体接收的真实空间失败保持无目标发布，ID 接纳后不能重用', async (t) => {
  const fixture = await setup(t, { archiveOptions: { io: { availableBytes: async () => 0n } } })
  const payload = fixture.payload()
  await register(fixture, payload)
  assert.equal((await upload(fixture, payload)).status, 507)
  const terminal = await waitState(fixture, payload)
  assert.equal(terminal.error.code, 'insufficient-space')
  assert.deepEqual(await readdir(fixture.root), [])
  assert.equal((await register(fixture, payload)).json.error.code, 'task-conflict')
})

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function waitGate(gate, signal) {
  if (signal.aborted) return
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

test('验证阶段取消等待原生归档收尾，没有逐文件目标发布', async (t) => {
  const entered = deferred()
  const gate = deferred()
  const fixture = await setup(t, {
    wrapArchive: (archive) => ({
      prepare: archive.prepare.bind(archive),
      retryCleanup: archive.retryCleanup.bind(archive),
      receive: async (manifest, input, options) => {
        const artifact = await archive.receive(manifest, input, options)
        entered.resolve()
        await waitGate(gate, options.signal)
        if (options.signal.aborted) {
          await artifact.dispose()
          throw new ArchiveCancelledError()
        }
        return artifact
      },
    }),
  })
  const payload = fixture.payload()
  try {
    await register(fixture, payload)
    assert.equal((await upload(fixture, payload)).status, 202)
    await entered.promise
    assert.equal((await request(fixture, '/v1/transfers/upload-1')).json.value.stage, 'verifying')
    await request(fixture, '/v1/transfers/upload-1', { method: 'DELETE' })
    const terminal = await waitState(fixture, payload)
    assert.equal(terminal.status, 'cancelled')
    assert.ok(terminal.fileResults.every((result) => result.reason === 'cancelled'))
    assert.deepEqual(await readdir(fixture.root), [])
  } finally {
    gate.resolve()
  }
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

test('最后文件在取消竞争中实际发布成功时整批仍成功，不伪造回滚', async (t) => {
  const hook = { fixture: null }
  const fixture = await setup(t, {
    publisherOptions: {
      io: {
        link: async (candidate, target) => {
          await link(candidate, target)
          if (basename(target) === '较大文件.sav')
            await request(hook.fixture, '/v1/transfers/upload-1', { method: 'DELETE' })
        },
      },
    },
  })
  hook.fixture = fixture
  const payload = fixture.payload()
  await register(fixture, payload)
  await upload(fixture, payload)
  const terminal = await waitState(fixture, payload)
  assert.equal(terminal.status, 'succeeded')
  assert.ok(terminal.fileResults.every((result) => result.status === 'succeeded'))
})

test('发布结果不确定时保留前项与当前实际文件，后项停止且禁止直接重用 ID', async (t) => {
  const fixture = await setup(t, {
    publisherOptions: {
      io: {
        link: async (candidate, target) => {
          await link(candidate, target)
          if (basename(target) === '100% 存档.sav') throw new Error('link 回执丢失')
        },
      },
    },
  })
  const payload = fixture.payload()
  await register(fixture, payload)
  await upload(fixture, payload)
  const terminal = await waitState(fixture, payload)
  assert.equal(terminal.status, 'unknown')
  assert.equal(terminal.error.code, 'result-unknown')
  assert.equal(terminal.error.canRetry, false)
  assert.deepEqual(
    terminal.fileResults.map((result) => result.status),
    ['succeeded', 'unknown', 'not-attempted'],
  )
  assert.equal(terminal.fileResults[2].reason, 'prior-failure')
  assert.ok((await readdir(fixture.root)).includes('100% 存档.sav'))
  assert.ok(!(await readdir(fixture.root)).includes('较大文件.sav'))
  assert.equal((await register(fixture, payload)).json.error.code, 'task-conflict')
})

test('前项候选清理失败时保留成功，后续启动失败准确反馈并停止', async (t) => {
  const fault = { blocked: true }
  const fixture = await setup(t, {
    publisherOptions: {
      io: {
        unlink: async (path) => {
          if (fault.blocked) throw new Error('blocked')
          await unlink(path)
        },
      },
    },
  })
  const payload = fixture.payload()
  try {
    await register(fixture, payload)
    await upload(fixture, payload)
    const terminal = await waitState(fixture, payload)
    assert.equal(terminal.status, 'failed')
    assert.deepEqual(
      terminal.fileResults.map((result) => result.status),
      ['succeeded', 'failed', 'not-attempted'],
    )
    assert.equal(terminal.fileResults[1].error.code, 'cleanup-failed')
    assert.equal(terminal.cleanupStatus, 'incomplete')
    assert.equal((await lstat(join(fixture.root, '空 文件.sav'))).size, 0)
    assert.ok(!(await readdir(fixture.root)).includes('100% 存档.sav'))
    fault.blocked = false
    await fixture.service.retryCleanup()
    assert.ok(!(await readdir(fixture.root)).some((name) => name.startsWith('.savedata-new-')))
  } finally {
    fault.blocked = false
    await fixture.service.retryCleanup()
  }
})

test('所有文件已发布但私有缓存清理失败时成功保留，明确重试后释放名额', async (t) => {
  const fault = { blocked: true }
  const fixture = await setup(t, {
    archiveOptions: {
      io: {
        unlinkFile: async (path) => {
          if (fault.blocked) throw new Error('cache blocked')
          await unlink(path)
        },
      },
    },
  })
  const payload = fixture.payload()
  try {
    await register(fixture, payload)
    await upload(fixture, payload)
    const terminal = await waitState(fixture, payload)
    assert.equal(terminal.status, 'succeeded')
    assert.equal(terminal.cleanupStatus, 'incomplete')
    assert.equal(terminal.cleanupError.code, 'cleanup-failed')
    fault.blocked = false
    await fixture.service.retryCleanup()
    assert.equal(
      (await request(fixture, '/v1/transfers/upload-1')).json.value.cleanupStatus,
      'complete',
    )
    assert.deepEqual(await readdir(fixture.cacheRoot), ['cache-root.json'])
  } finally {
    fault.blocked = false
    await fixture.service.retryCleanup()
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

test('收齐前真实连接中断报告 network-failure，不产生目标文件', async (t) => {
  const fixture = await setup(t)
  const payload = fixture.payload()
  await register(fixture, payload)
  const header = `PUT /v1/transfers/upload-1/content HTTP/1.1\r\nHost: localhost\r\nX-Sync-Session-Id: ${fixture.address.sessionId}\r\nContent-Type: application/gzip\r\nContent-Length: ${payload.bytes.length}\r\nX-Archive-Sha256: ${payload.request.manifest.archive.sha256}\r\n\r\n`
  const socket = connect({ host: '127.0.0.1', port: fixture.address.port }, () =>
    socket.write(Buffer.concat([Buffer.from(header), payload.bytes.subarray(0, 1)])),
  )
  socket.on('error', () => undefined)
  try {
    await waitState(fixture, payload, (state) => state.stage === 'transferring')
    socket.destroy()
    const terminal = await waitState(fixture, payload)
    assert.equal(terminal.error.code, 'network-failure')
  } finally {
    socket.destroy()
  }
  assert.deepEqual(await readdir(fixture.root), [])
})

test('上传无进展期限会中断阻塞消息，查询不续期，实际状态为 timeout', async (t) => {
  const clock = { now: 1000 }
  const fixture = await setup(t, {
    serviceOptions: { now: () => clock.now, timeouts: { networkIdle: 20 } },
  })
  const payload = fixture.payload()
  await register(fixture, payload)
  const header = `PUT /v1/transfers/upload-1/content HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nX-Sync-Session-Id: ${fixture.address.sessionId}\r\nContent-Type: application/gzip\r\nContent-Length: ${payload.bytes.length}\r\nX-Archive-Sha256: ${payload.request.manifest.archive.sha256}\r\n\r\n`
  const response = raw(fixture, Buffer.concat([Buffer.from(header), payload.bytes.subarray(0, 1)]))
  await waitState(fixture, payload, (state) => state.stage === 'transferring')
  clock.now += 21
  assert.match(await response, /^HTTP\/1\.1 408/)
  const terminal = await waitState(fixture, payload)
  assert.equal(terminal.error.code, 'timeout')
  assert.deepEqual(await readdir(fixture.root), [])
})

test('同一登记内容并发 PUT 只有一次领取，完整结果不重复发布', async (t) => {
  const fixture = await setup(t)
  const payload = fixture.payload()
  await register(fixture, payload)
  const responses = await Promise.all([upload(fixture, payload), upload(fixture, payload)])
  assert.deepEqual(responses.map((response) => response.status).sort(), [202, 409])
  assert.equal((await waitState(fixture, payload)).status, 'succeeded')
  assert.equal((await readdir(fixture.root)).length, 3)
})

test('实际大于缓冲区的不可压缩 HTTP 上传经过流背压且原文一致', async (t) => {
  const fixture = await setup(t)
  const largeRoot = join(fixture.base, 'large-source')
  await mkdir(largeRoot)
  const bytes = Buffer.alloc(200003)
  let value = 1234567
  for (let index = 0; index < bytes.length; index++) {
    value ^= value << 13
    value ^= value >>> 17
    value ^= value << 5
    bytes[index] = value & 255
  }
  await writeFile(join(largeRoot, 'large.sav'), bytes)
  const selected = unwrap(await fixture.source.registerDirectory(largeRoot))
  const entry = unwrap(await fixture.source.listDirectory(selected.rootId)).entries[0]
  const artifact = await fixture.archive.prepare({
    protocolVersion: 1,
    transferId: 'large-transfer',
    sourceRootId: selected.rootId,
    files: [{ fileId: 'f000001', entryId: entry.entryId }],
  })
  const chunks = []
  for await (const chunk of await artifact.openArchive()) chunks.push(chunk)
  const compressed = Buffer.concat(chunks)
  const manifest = artifact.manifest
  await artifact.dispose()
  assert.ok(compressed.length > 65536)
  const payload = {
    bytes: compressed,
    request: {
      protocolVersion: 1,
      manifest,
      targetRootId: fixture.selected.rootId,
      targets: [{ fileId: 'f000001', parentId: null, name: 'large-target.sav' }],
    },
  }
  await register(fixture, payload)
  assert.equal((await upload(fixture, payload)).status, 202)
  assert.equal((await waitState(fixture, payload)).status, 'succeeded')
  assert.deepEqual(await readFile(join(fixture.root, 'large-target.sav')), bytes)
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

test('总期限覆盖验证阶段，压缩体已确认仍可超时且没有目标发布', async (t) => {
  const clock = { now: 1000 }
  const entered = deferred()
  const gate = deferred()
  const fixture = await setup(t, {
    serviceOptions: { now: () => clock.now, timeouts: { total: 20 } },
    wrapArchive: (archive) => ({
      prepare: archive.prepare.bind(archive),
      retryCleanup: archive.retryCleanup.bind(archive),
      receive: async (manifest, input, options) => {
        const artifact = await archive.receive(manifest, input, options)
        entered.resolve()
        await waitGate(gate, options.signal)
        if (options.signal.aborted) {
          await artifact.dispose()
          throw new ArchiveCancelledError()
        }
        return artifact
      },
    }),
  })
  const payload = fixture.payload()
  try {
    await register(fixture, payload)
    assert.equal((await upload(fixture, payload)).status, 202)
    await entered.promise
    clock.now += 21
    const terminal = await waitState(fixture, payload)
    assert.equal(terminal.status, 'failed')
    assert.equal(terminal.error.code, 'timeout')
    assert.deepEqual(await readdir(fixture.root), [])
  } finally {
    gate.resolve()
  }
})

test('停止正在收体的服务关闭请求并等待缓存收尾，原端口可重新使用', async (t) => {
  const fixture = await setup(t)
  const payload = fixture.payload()
  await register(fixture, payload)
  const header = `PUT /v1/transfers/upload-1/content HTTP/1.1\r\nHost: localhost\r\nX-Sync-Session-Id: ${fixture.address.sessionId}\r\nContent-Type: application/gzip\r\nContent-Length: ${payload.bytes.length}\r\nX-Archive-Sha256: ${payload.request.manifest.archive.sha256}\r\n\r\n`
  const socket = connect({ host: '127.0.0.1', port: fixture.address.port }, () =>
    socket.write(Buffer.concat([Buffer.from(header), payload.bytes.subarray(0, 1)])),
  )
  socket.on('error', () => undefined)
  try {
    await waitState(fixture, payload, (state) => state.stage === 'transferring')
    await fixture.service.stop()
    assert.deepEqual(await readdir(fixture.cacheRoot), ['cache-root.json'])
    assert.deepEqual(await readdir(fixture.root), [])
    const next = await fixture.service.start({ port: fixture.address.port })
    assert.equal(next.port, fixture.address.port)
  } finally {
    socket.destroy()
  }
})

test('异步预检期间停止服务会等待原生检查，不接纳迟到任务也不遗留进程名额', async (t) => {
  const entered = deferred()
  const gate = deferred()
  const fixture = await setup(t, {
    wrapPublisher: (publisher) => ({
      publish: publisher.publish.bind(publisher),
      retryCleanup: publisher.retryCleanup.bind(publisher),
      checkTarget: async (value) => {
        entered.resolve()
        await gate.promise
        return publisher.checkTarget(value)
      },
    }),
  })
  const payload = fixture.payload()
  const registering = register(fixture, payload).then(
    (value) => ({ value }),
    (error) => ({ error }),
  )
  let hasStopped = false
  try {
    await entered.promise
    const stopping = fixture.service.stop().then(() => {
      hasStopped = true
    })
    await sleep(5)
    assert.equal(hasStopped, false)
    gate.resolve()
    await stopping
    assert.ok((await registering).error)
    fixture.address = await fixture.service.start()
    assert.equal((await register(fixture, payload)).status, 201)
  } finally {
    gate.resolve()
  }
})

test('发布结果上下文不匹配时不能接受成功，保留实际文件并报告 unknown', async (t) => {
  const fixture = await setup(t, {
    wrapPublisher: (publisher) => ({
      checkTarget: publisher.checkTarget.bind(publisher),
      retryCleanup: publisher.retryCleanup.bind(publisher),
      publish: async (...arguments_) => {
        const result = await publisher.publish(...arguments_)
        return result.outcome.status === 'succeeded' && result.outcome.fileId === 'f000002'
          ? {
              ...result,
              outcome: {
                ...result.outcome,
                entry: { ...result.outcome.entry, name: 'wrong-target.sav' },
              },
            }
          : result
      },
    }),
  })
  const payload = fixture.payload()
  await register(fixture, payload)
  await upload(fixture, payload)
  const terminal = await waitState(fixture, payload)
  assert.equal(terminal.status, 'unknown')
  assert.deepEqual(
    terminal.fileResults.map((result) => result.status),
    ['succeeded', 'unknown', 'not-attempted'],
  )
  assert.ok((await readdir(fixture.root)).includes('100% 存档.sav'))
})

test('畸形上传登记、跨根父引用和未来版本拒绝后仍可使用同一有效 ID', async (t) => {
  const fixture = await setup(t)
  const payload = fixture.payload()
  for (const value of [
    { ...payload.request, protocolVersion: 2 },
    { ...payload.request, extra: true },
    { ...payload.request, targetRootId: '../outside' },
    {
      ...payload.request,
      targets: payload.request.targets.map((item) => ({ ...item, parentId: 'missing-parent' })),
    },
  ]) {
    const response = await request(fixture, '/v1/transfers/uploads', { method: 'POST', value })
    assert.ok([400, 404, 409].includes(response.status))
  }
  assert.equal((await register(fixture, payload)).status, 201)
})
