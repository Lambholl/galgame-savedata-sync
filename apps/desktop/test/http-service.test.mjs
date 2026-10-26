import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { Readable } from 'node:stream'
import { gunzipSync } from 'node:zlib'
import test from 'node:test'
import {
  BATCH_LIMITS,
  isBatchState,
  isBatchProgressAdvance,
  matchesBatchState,
} from '@savedata-sync/shared'
import { createDirectoryAdapter } from '../src/main/directory-adapter.ts'
import { createWindowsArchiveAdapter } from '../src/main/archive-adapter.ts'
import { WindowsHttpService } from '../src/main/http-service.ts'
import { WindowsTransferRegistry } from '../src/main/transfer-registry.ts'
import { ArchiveCancelledError, ArchiveError } from '../src/main/archive-errors.ts'

const HASH = (bytes) => createHash('sha256').update(bytes).digest('hex')
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const unwrap = (result) => {
  assert.equal(result.status, 'success', JSON.stringify(result))
  return result.value
}

async function setup(t, options = {}) {
  const temporaryRoot = await realpath(tmpdir())
  const base = await mkdtemp(join(temporaryRoot, 'savedata-http-test-'))
  const services = []
  t.after(async () => {
    for (const service of services) await service.stop()
    const child = relative(temporaryRoot, base)
    assert.ok(
      child &&
        child !== '..' &&
        !child.startsWith(`..${sep}`) &&
        !isAbsolute(child) &&
        base.includes('savedata-http-test-'),
    )
    await rm(base, { recursive: true, force: true })
  })
  const root = join(base, '源 存档')
  const privateDirectory = join(base, 'private')
  await mkdir(root)
  await mkdir(privateDirectory)
  await mkdir(join(root, '子目录'))
  const content = Buffer.from('真实 HTTP 合成存档 😀')
  await writeFile(join(root, '源 %.sav'), content)
  const source = await createDirectoryAdapter(join(base, 'control', 'directories.json'))
  const selected = unwrap(await source.registerDirectory(root))
  const listing = unwrap(await source.listDirectory(selected.rootId))
  const entry = listing.entries.find((item) => item.kind === 'file')
  const request = {
    protocolVersion: 1,
    transferId: 'batch-1',
    sourceRootId: selected.rootId,
    files: [{ fileId: 'f000001', entryId: entry.entryId }],
  }
  const archive = await createWindowsArchiveAdapter(
    source,
    privateDirectory,
    options.archiveOptions,
  )
  const create = (archiveProvider = archive, serviceOptions = {}, directorySource = source) => {
    const service = new WindowsHttpService(directorySource, archiveProvider, serviceOptions)
    services.push(service)
    return service
  }
  const service = create(
    options.wrapArchive ? options.wrapArchive(archive) : archive,
    options.serviceOptions,
  )
  const address = await service.start()
  return {
    base,
    root,
    source,
    archive,
    request,
    selected,
    listing,
    entry,
    content,
    create,
    service,
    address,
    cacheRoot: join(privateDirectory, 'transfer-archives-v1'),
  }
}

async function request(fixture, path, options = {}) {
  const body =
    options.rawBody ??
    (options.value === undefined ? null : Buffer.from(JSON.stringify(options.value)))
  const headers = {
    ...(options.session === false ? {} : { 'x-sync-session-id': fixture.address.sessionId }),
    ...(body === null ? {} : { 'content-type': 'application/json', 'content-length': body.length }),
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
          const json = response.headers['content-type']?.startsWith('application/json')
            ? JSON.parse(bytes.toString('utf8'))
            : null
          resolve({ status: response.statusCode, headers: response.headers, bytes, json })
        })
      },
    )
    outgoing.once('error', reject)
    outgoing.setTimeout(5000, () => outgoing.destroy(new Error('测试请求超时')))
    outgoing.end(body)
  })
}

async function waitState(
  fixture,
  predicate = (state) => state.status !== 'running' || state.stage === 'ready',
  id = fixture.request.transferId,
) {
  for (let index = 0; index < 200; index++) {
    const response = await request(fixture, `/v1/transfers/${id}`)
    assert.equal(response.status, 200)
    const state = unwrap(response.json)
    assert.ok(isBatchState(state), JSON.stringify(state))
    if (predicate(state)) return state
    await sleep(5)
  }
  assert.fail('任务未在测试期限内到达预期状态')
}

function raw(fixture, bytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    const socket = connect({ host: '127.0.0.1', port: fixture.address.port }, () =>
      socket.write(bytes),
    )
    socket.on('data', (chunk) => chunks.push(chunk))
    socket.once('error', (error) =>
      chunks.length ? resolve(Buffer.concat(chunks).toString('utf8')) : reject(error),
    )
    socket.once('close', () => resolve(Buffer.concat(chunks).toString('utf8')))
    socket.setTimeout(3000, () => socket.destroy(new Error('原始请求测试超时')))
  })
}

test('设备/根/当前层通过真实 HTTP 返回公开 DTO，会话与目录边界分开', async (t) => {
  const fixture = await setup(t)
  const device = await request(fixture, '/v1/device', { session: false })
  assert.equal(device.status, 200)
  const descriptor = unwrap(device.json)
  assert.equal(descriptor.device.deviceId, fixture.source.deviceId)
  assert.equal(descriptor.device.protocolVersion, 1)
  assert.equal(descriptor.device.capabilities.canReceiveFiles, 'unsupported')
  assert.deepEqual(descriptor.limits, BATCH_LIMITS)
  assert.equal(descriptor.sessionId, fixture.address.sessionId)
  const roots = await request(fixture, '/v1/roots')
  assert.equal(roots.headers['cache-control'], 'no-store')
  assert.equal(unwrap(roots.json)[0].rootId, fixture.selected.rootId)
  const listing = unwrap(
    (await request(fixture, `/v1/roots/${fixture.selected.rootId}/entries`)).json,
  )
  assert.equal(listing.entries.length, 2)
  const directory = listing.entries.find((entry) => entry.kind === 'directory')
  assert.equal(directory.sizeBytes, null)
  assert.deepEqual(
    unwrap(
      (
        await request(
          fixture,
          `/v1/roots/${fixture.selected.rootId}/entries?parentId=${directory.entryId}`,
        )
      ).json,
    ).entries,
    [],
  )
  assert.equal(
    (await request(fixture, '/v1/roots', { session: false })).json.error.code,
    'session-mismatch',
  )
  assert.equal(
    (await request(fixture, '/v1/roots/wrong-root/entries')).json.error.code,
    'not-found',
  )
  assert.ok(!JSON.stringify([device.json, roots.json, listing]).includes(fixture.base))
})

test('异步下载准备、独立清单和单次 gzip 内容可校验，sent 不冒充发布成功', async (t) => {
  const fixture = await setup(t)
  const accepted = await request(fixture, '/v1/transfers/downloads', {
    method: 'POST',
    value: fixture.request,
  })
  assert.equal(accepted.status, 202)
  assert.equal(unwrap(accepted.json).stage, 'preparing')
  const ready = await waitState(fixture)
  assert.equal(ready.stage, 'ready')
  const manifest = unwrap(
    (await request(fixture, `/v1/transfers/${fixture.request.transferId}/manifest`)).json,
  )
  assert.ok(matchesBatchState(ready, manifest, 'windows-to-android'))
  assert.equal(manifest.files[0].sha256, HASH(fixture.content))
  const received = await request(fixture, `/v1/transfers/${fixture.request.transferId}/content`)
  assert.equal(received.status, 200)
  assert.equal(received.headers['content-type'], 'application/gzip')
  assert.equal(received.headers['content-encoding'], undefined)
  assert.equal(received.headers['transfer-encoding'], undefined)
  assert.equal(received.headers['content-length'], String(received.bytes.length))
  assert.equal(received.headers['x-archive-sha256'], HASH(received.bytes))
  assert.equal(manifest.archive.sha256, HASH(received.bytes))
  const tar = gunzipSync(received.bytes)
  assert.deepEqual(tar.subarray(512, 512 + fixture.content.length), fixture.content)
  const terminal = await waitState(fixture, (state) => state.status !== 'running')
  assert.equal(terminal.status, 'sent')
  assert.equal(terminal.fileResults, null)
  assert.equal(terminal.cleanupStatus, 'complete')
  assert.ok(matchesBatchState(terminal, manifest, 'windows-to-android'))
  assert.equal(
    (await request(fixture, `/v1/transfers/${fixture.request.transferId}/content`)).json.error.code,
    'task-conflict',
  )
  assert.deepEqual(
    (await request(fixture, `/v1/transfers/${fixture.request.transferId}/manifest`)).json.value,
    manifest,
  )
  assert.deepEqual(await readdir(fixture.cacheRoot), ['cache-root.json'])
  assert.deepEqual(await readFile(join(fixture.root, '源 %.sav')), fixture.content)
})

test('并发相同 ID 只接纳一次，忙碌与单次内容领取在 await 前生效', async (t) => {
  const fixture = await setup(t)
  const results = await Promise.all(
    [1, 2].map(() =>
      request(fixture, '/v1/transfers/downloads', { method: 'POST', value: fixture.request }),
    ),
  )
  assert.deepEqual(results.map((result) => result.status).sort(), [202, 409])
  const busy = await request(fixture, '/v1/transfers/downloads', {
    method: 'POST',
    value: { ...fixture.request, transferId: 'batch-2' },
  })
  assert.equal(busy.json.error.code, 'busy')
  await waitState(fixture)
  const contents = await Promise.all(
    [1, 2].map(() => request(fixture, '/v1/transfers/batch-1/content')),
  )
  assert.deepEqual(contents.map((result) => result.status).sort(), [200, 409])
})

test('ready 取消等待清理，重复 DELETE 返回实际终态且不重用任务 ID', async (t) => {
  const fixture = await setup(t)
  await request(fixture, '/v1/transfers/downloads', { method: 'POST', value: fixture.request })
  await waitState(fixture)
  const cancelled = await request(fixture, '/v1/transfers/batch-1', { method: 'DELETE' })
  assert.equal(cancelled.status, 202)
  assert.equal(unwrap(cancelled.json).cancelRequested, true)
  const terminal = await waitState(fixture, (state) => state.status !== 'running')
  assert.equal(terminal.status, 'cancelled')
  assert.equal(terminal.error, null)
  assert.equal((await request(fixture, '/v1/transfers/batch-1', { method: 'DELETE' })).status, 200)
  assert.equal(
    (await request(fixture, '/v1/transfers/downloads', { method: 'POST', value: fixture.request }))
      .json.error.code,
    'task-conflict',
  )
  const next = await request(fixture, '/v1/transfers/downloads', {
    method: 'POST',
    value: { ...fixture.request, transferId: 'batch-2' },
  })
  assert.equal(next.status, 202)
})

test('格式错误不占用 ID；错误版本、额外字段、URI 和越界引用不能变成可读路径', async (t) => {
  const fixture = await setup(t)
  for (const [value, code] of [
    [{ ...fixture.request, protocolVersion: 2 }, 'protocol-mismatch'],
    [{ ...fixture.request, path: fixture.root }, 'invalid-request'],
    [{ ...fixture.request, sourceRootId: '../root' }, 'invalid-request'],
    [
      { ...fixture.request, files: [{ fileId: 'f000001', entryId: 'content://uri' }] },
      'invalid-request',
    ],
  ])
    assert.equal(
      (await request(fixture, '/v1/transfers/downloads', { method: 'POST', value })).json.error
        .code,
      code,
    )
  assert.equal(
    (await request(fixture, '/v1/transfers/downloads', { method: 'POST', value: fixture.request }))
      .status,
    202,
  )
})

test('严格路由拒绝多次解码、重复/未知查询、额外段、错误 method 和 Range', async (t) => {
  const fixture = await setup(t)
  for (const path of [
    '/v1/roots?x=1',
    '/v1/roots/',
    '/v1/../device',
    '/v1/%ZZ',
    '/v1/roots/a%252Fb/entries',
    '/v1/roots/a%2Fb/entries',
    `/v1/roots/${fixture.selected.rootId}/entries?parentId=a&%70arentId=b`,
    `/v1/roots/${fixture.selected.rootId}/entries?parentId=`,
    '/v1/device#hidden',
  ]) {
    assert.equal((await request(fixture, path)).status, 400, path)
  }
  assert.equal((await request(fixture, '/v1/device', { method: 'POST' })).status, 400)
  assert.equal(
    (await request(fixture, '/v1/device', { headers: { range: 'bytes=0-1' } })).status,
    400,
  )
  assert.equal(
    (await request(fixture, '/v1/transfers/uploads', { method: 'POST', value: {} })).status,
    400,
  )
})

test('JSON 拒绝所有层级的重复解码键、非法 UTF-8、BOM、嵌套过深和编码体', async (t) => {
  const fixture = await setup(t)
  for (const rawBody of [
    Buffer.from('{"a":1,"\\u0061":2}'),
    Buffer.from('{"files":[{"id":1,"id":2}]}'),
    Buffer.from([123, 34, 97, 34, 58, 34, 255, 34, 125]),
    Buffer.from('\uFEFF{}'),
    Buffer.from('['.repeat(130) + '0' + ']'.repeat(130)),
    Buffer.from('{} trailing'),
  ]) {
    assert.equal(
      (await request(fixture, '/v1/transfers/downloads', { method: 'POST', rawBody })).status,
      400,
    )
  }
  assert.equal(
    (
      await request(fixture, '/v1/transfers/downloads', {
        method: 'POST',
        value: fixture.request,
        headers: { 'content-encoding': 'gzip' },
      })
    ).status,
    400,
  )
})

test('真实 TCP 拒绝重复/冲突头、CL/TE 歧义及未知 Expect，不吞掉 socket 错误', async (t) => {
  const fixture = await setup(t)
  const session = `X-Sync-Session-Id: ${fixture.address.sessionId}\r\n`
  for (const headers of [
    session + session,
    session + 'Content-Length: 0\r\nContent-Length: 0\r\n',
    session + 'Content-Length: 0\r\nTransfer-Encoding: chunked\r\n',
    session + 'Host: extra\r\n',
    session + 'Expect: 100-continue\r\n',
  ]) {
    const response = await raw(
      fixture,
      `GET /v1/roots HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n${headers}\r\n`,
    )
    assert.match(response, /^HTTP\/1\.1 400/)
  }
})

test('JSON 请求/响应硬限计实际 UTF-8 字节，超过声明预算在解析前拒绝', async (t) => {
  const fixture = await setup(t)
  const response = await raw(
    fixture,
    `POST /v1/transfers/downloads HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nX-Sync-Session-Id: ${fixture.address.sessionId}\r\nContent-Type: application/json\r\nContent-Length: ${BATCH_LIMITS.maxJsonBytes + 1}\r\n\r\n`,
  )
  assert.match(response, /^HTTP\/1\.1 413/)
  const large = Buffer.from(' '.repeat(BATCH_LIMITS.maxJsonBytes) + '{}')
  const streamed = await request(fixture, '/v1/transfers/downloads', {
    method: 'POST',
    rawBody: large,
    headers: { 'content-length': undefined, 'transfer-encoding': 'chunked' },
  })
  assert.equal(streamed.status, 413)
  const extra = fixture.create(
    fixture.archive,
    {},
    {
      deviceId: fixture.source.deviceId,
      listDirectory: fixture.source.listDirectory.bind(fixture.source),
      listRoots: async () => ({
        status: 'success',
        value: ['中'.repeat(BATCH_LIMITS.maxJsonBytes / 2)],
      }),
    },
  )
  const address = await extra.start()
  assert.equal((await request({ address }, '/v1/roots')).status, 413)
})

test('终态到期清除结果/清单但保留已用 ID，容量满不淘汰防重标识', async (t) => {
  const clock = { now: 1000 }
  const fixture = await setup(t, {
    serviceOptions: { now: () => clock.now, maxTransfers: 1, timeouts: { terminalRetention: 10 } },
  })
  await request(fixture, '/v1/transfers/downloads', { method: 'POST', value: fixture.request })
  await waitState(fixture)
  await request(fixture, '/v1/transfers/batch-1', { method: 'DELETE' })
  await waitState(fixture, (state) => state.status !== 'running')
  clock.now += 11
  assert.equal((await request(fixture, '/v1/transfers/batch-1')).json.error.code, 'result-unknown')
  assert.equal(
    (await request(fixture, '/v1/transfers/batch-1/manifest')).json.error.code,
    'result-unknown',
  )
  assert.equal(
    (await request(fixture, '/v1/transfers/downloads', { method: 'POST', value: fixture.request }))
      .json.error.code,
    'task-conflict',
  )
  assert.equal(
    (
      await request(fixture, '/v1/transfers/downloads', {
        method: 'POST',
        value: { ...fixture.request, transferId: 'fresh-id' },
      })
    ).json.error.code,
    'resource-limit',
  )
})

test('ready 期限不被查询延长，超时先清理后允许下一任务', async (t) => {
  const clock = { now: 1000 }
  const fixture = await setup(t, {
    serviceOptions: { now: () => clock.now, timeouts: { ready: 20 } },
  })
  await request(fixture, '/v1/transfers/downloads', { method: 'POST', value: fixture.request })
  await waitState(fixture)
  clock.now += 10
  assert.equal((await request(fixture, '/v1/transfers/batch-1')).json.value.stage, 'ready')
  clock.now += 11
  const terminal = await waitState(fixture, (state) => state.status !== 'running')
  assert.equal(terminal.status, 'failed')
  assert.equal(terminal.error.code, 'timeout')
  assert.equal(terminal.cleanupStatus, 'complete')
})

test('停止服务取消准备任务，等待原生资源关闭；重启保留设备但更换会话', async (t) => {
  const fixture = await setup(t)
  await request(fixture, '/v1/transfers/downloads', { method: 'POST', value: fixture.request })
  const previous = fixture.address
  await Promise.all([fixture.service.stop(), fixture.service.stop()])
  assert.equal(fixture.service.getAddress(), null)
  assert.deepEqual(await readdir(fixture.cacheRoot), ['cache-root.json'])
  fixture.address = await fixture.service.start({ port: previous.port })
  assert.notEqual(fixture.address.sessionId, previous.sessionId)
  const device = unwrap((await request(fixture, '/v1/device')).json)
  assert.equal(device.device.deviceId, fixture.source.deviceId)
  assert.equal(
    (await request(fixture, '/v1/roots', { headers: { 'x-sync-session-id': previous.sessionId } }))
      .status,
    409,
  )
  assert.equal((await request(fixture, '/v1/transfers/batch-1')).json.error.code, 'result-unknown')
  assert.equal(
    (await request(fixture, '/v1/transfers/downloads', { method: 'POST', value: fixture.request }))
      .status,
    202,
  )
})

test('监听冲突明确失败，不换端口；停止后端口与缓存可复用', async (t) => {
  const fixture = await setup(t)
  const extra = fixture.create()
  await assert.rejects(
    extra.start({ port: fixture.address.port }),
    (error) =>
      error.operationError?.code === 'io-failure' &&
      !error.operationError.message.includes(fixture.base),
  )
  await fixture.service.stop()
  const address = await extra.start({ port: fixture.address.port })
  assert.equal(address.port, fixture.address.port)
})

test('已接纳的源引用失败占用 ID，错误不暴露原始路径', async (t) => {
  const fixture = await setup(t)
  const value = { ...fixture.request, files: [{ fileId: 'f000001', entryId: 'missing-entry' }] }
  assert.equal(
    (await request(fixture, '/v1/transfers/downloads', { method: 'POST', value })).status,
    202,
  )
  const terminal = await waitState(fixture, (state) => state.status !== 'running')
  assert.equal(terminal.status, 'failed')
  assert.equal(terminal.error.code, 'not-found')
  assert.ok(!JSON.stringify(terminal).includes(fixture.base))
  assert.equal(
    (await request(fixture, '/v1/transfers/downloads', { method: 'POST', value })).status,
    409,
  )
})

test('准备阶段总期限等待原生 worker，超时原因不会被源错误覆盖', async (t) => {
  const fixture = await setup(t)
  const clock = { now: 1000 }
  const active = []
  t.after(async () => {
    for (const registry of active) await registry.stop()
  })
  let signal
  let release
  const provider = {
    retryCleanup: async () => undefined,
    prepare: async (value, options) => {
      void value
      signal = options.signal
      await new Promise((resolve) => {
        release = resolve
      })
      throw new ArchiveError('source-changed', '源变化。')
    },
  }
  const registry = new WindowsTransferRegistry(provider, {
    now: () => clock.now,
    timeouts: { total: 10 },
  })
  active.push(registry)
  registry.registerDownload(fixture.request)
  await sleep(0)
  clock.now += 11
  registry.sweep()
  assert.equal(signal.aborted, true)
  assert.equal(registry.getState('batch-1').status, 'running')
  assert.throws(
    () => registry.registerDownload({ ...fixture.request, transferId: 'other' }),
    (error) => error.operationError.code === 'busy',
  )
  release()
  for (let index = 0; index < 100 && registry.getState('batch-1').status === 'running'; index++)
    await sleep(1)
  assert.equal(registry.getState('batch-1').error.code, 'timeout')
})

function partialArchive(archive, capture) {
  return {
    retryCleanup: () => archive.retryCleanup(),
    prepare: async (value, options) => {
      const artifact = await archive.prepare(value, options)
      return {
        ...artifact,
        openArchive: async () => {
          const chunks = []
          for await (const chunk of await artifact.openArchive()) chunks.push(chunk)
          const bytes = Buffer.concat(chunks)
          let emitted = false
          const stream = new Readable({
            read() {
              if (!emitted) {
                emitted = true
                this.push(bytes.subarray(0, 1))
              }
            },
          })
          capture.stream = stream
          return stream
        },
      }
    },
  }
}

test('传输阶段取消关闭实际 HTTP 与原生流，进度单调且不伪报 sent', async (t) => {
  const capture = {}
  const fixture = await setup(t, { wrapArchive: (archive) => partialArchive(archive, capture) })
  await request(fixture, '/v1/transfers/downloads', { method: 'POST', value: fixture.request })
  const ready = await waitState(fixture)
  const streamResult = request(fixture, '/v1/transfers/batch-1/content').then(
    (value) => ({ value }),
    (error) => ({ error }),
  )
  const transferring = await waitState(
    fixture,
    (state) =>
      state.status === 'running' &&
      state.stage === 'transferring' &&
      state.progress.archiveBytesTransferred === 1,
  )
  assert.ok(isBatchProgressAdvance(ready.progress, transferring.progress))
  assert.equal(transferring.progress.fileBytesPublished, 0)
  assert.equal(transferring.progress.fileBytesVerified, 0)
  await request(fixture, '/v1/transfers/batch-1', { method: 'DELETE' })
  assert.ok((await streamResult).error)
  const terminal = await waitState(fixture, (state) => state.status !== 'running')
  assert.equal(terminal.status, 'cancelled')
  assert.equal(terminal.cleanupStatus, 'complete')
  assert.equal(capture.stream.destroyed, true)
})

test('接收方断开真实 TCP 后报告 network-failure，关闭读流并释放缓存', async (t) => {
  const capture = {}
  const fixture = await setup(t, { wrapArchive: (archive) => partialArchive(archive, capture) })
  await request(fixture, '/v1/transfers/downloads', { method: 'POST', value: fixture.request })
  await waitState(fixture)
  await new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: '127.0.0.1',
        port: fixture.address.port,
        path: '/v1/transfers/batch-1/content',
        headers: { 'x-sync-session-id': fixture.address.sessionId },
        agent: false,
      },
      (response) => {
        response.once('data', () => {
          response.destroy()
          resolve()
        })
        response.on('error', () => resolve())
      },
    )
    outgoing.once('error', reject)
    outgoing.end()
  })
  const terminal = await waitState(fixture, (state) => state.status !== 'running')
  assert.equal(terminal.status, 'failed')
  assert.equal(terminal.error.code, 'network-failure')
  assert.equal(terminal.cleanupStatus, 'complete')
  assert.equal(capture.stream.destroyed, true)
  assert.deepEqual(await readdir(fixture.cacheRoot), ['cache-root.json'])
})

test('无网络进展期限不被状态查询续期，超时会中断阻塞发送', async (t) => {
  const capture = {}
  const clock = { now: 1000 }
  const fixture = await setup(t, {
    wrapArchive: (archive) => partialArchive(archive, capture),
    serviceOptions: {
      now: () => clock.now,
      timeouts: { networkIdle: 20 },
    },
  })
  await request(fixture, '/v1/transfers/downloads', { method: 'POST', value: fixture.request })
  await waitState(fixture)
  const result = request(fixture, '/v1/transfers/batch-1/content').then(
    (value) => ({ value }),
    (error) => ({ error }),
  )
  await waitState(
    fixture,
    (state) => state.stage === 'transferring' && state.progress.archiveBytesTransferred === 1,
  )
  clock.now += 10
  assert.equal((await request(fixture, '/v1/transfers/batch-1')).json.value.stage, 'transferring')
  clock.now += 11
  assert.ok((await result).error)
  const terminal = await waitState(fixture, (state) => state.status !== 'running')
  assert.equal(terminal.status, 'failed')
  assert.equal(terminal.error.code, 'timeout')
  assert.equal(capture.stream.destroyed, true)
})

test('发送校验失败关闭 gzip 响应，不在归档尾部拼接 JSON 或报告成功', async (t) => {
  const fixture = await setup(t, {
    wrapArchive: (archive) => ({
      retryCleanup: () => archive.retryCleanup(),
      prepare: async (value, options) => {
        const artifact = await archive.prepare(value, options)
        return {
          ...artifact,
          openArchive: async () =>
            Readable.from([Buffer.alloc(artifact.manifest.archive.sizeBytes, 42)]),
        }
      },
    }),
  })
  await request(fixture, '/v1/transfers/downloads', { method: 'POST', value: fixture.request })
  await waitState(fixture)
  await request(fixture, '/v1/transfers/batch-1/content').catch(() => undefined)
  const terminal = await waitState(fixture, (state) => state.status !== 'running')
  assert.equal(terminal.status, 'failed')
  assert.equal(terminal.error.code, 'checksum-mismatch')
  assert.equal(terminal.cleanupStatus, 'complete')
})

test('清理失败保留已确认 sent，阻止新任务，主进程重试后才释放名额', async (t) => {
  const fixture = await setup(t, {
    wrapArchive: (archive) => ({
      retryCleanup: () => archive.retryCleanup(),
      prepare: async (value, options) => {
        const artifact = await archive.prepare(value, options)
        return {
          ...artifact,
          dispose: async () => {
            throw new ArchiveError('cleanup-failed', '故障注入。')
          },
        }
      },
    }),
  })
  await request(fixture, '/v1/transfers/downloads', { method: 'POST', value: fixture.request })
  await waitState(fixture)
  assert.equal((await request(fixture, '/v1/transfers/batch-1/content')).status, 200)
  const terminal = await waitState(fixture, (state) => state.status !== 'running')
  assert.equal(terminal.status, 'sent')
  assert.equal(terminal.error, null)
  assert.equal(terminal.cleanupError.code, 'cleanup-failed')
  assert.equal(
    (
      await request(fixture, '/v1/transfers/downloads', {
        method: 'POST',
        value: { ...fixture.request, transferId: 'next-id' },
      })
    ).json.error.code,
    'busy',
  )
  await fixture.service.retryCleanup()
  assert.equal(
    (await request(fixture, '/v1/transfers/batch-1')).json.value.cleanupStatus,
    'complete',
  )
  assert.equal(
    (
      await request(fixture, '/v1/transfers/downloads', {
        method: 'POST',
        value: { ...fixture.request, transferId: 'next-id' },
      })
    ).status,
    202,
  )
})

test('取消与清理失败分开；结果到期后仍阻止新任务，停止失败可再次停止清理', async (t) => {
  const fault = { blocked: true }
  const clock = { now: 1000 }
  const fixture = await setup(t, {
    serviceOptions: { now: () => clock.now, timeouts: { terminalRetention: 10 } },
    wrapArchive: (archive) => ({
      retryCleanup: async () => {
        if (fault.blocked) throw new ArchiveError('cleanup-failed', '重试故障。')
        await archive.retryCleanup()
      },
      prepare: async (value, options) => {
        const artifact = await archive.prepare(value, options)
        return {
          ...artifact,
          dispose: async () => {
            throw new ArchiveError('cleanup-failed', '清理故障。')
          },
        }
      },
    }),
  })
  try {
    await request(fixture, '/v1/transfers/downloads', { method: 'POST', value: fixture.request })
    await waitState(fixture)
    await request(fixture, '/v1/transfers/batch-1', { method: 'DELETE' })
    const terminal = await waitState(fixture, (state) => state.status !== 'running')
    assert.equal(terminal.status, 'cancelled')
    assert.equal(terminal.error, null)
    assert.equal(terminal.cleanupStatus, 'incomplete')
    clock.now += 11
    assert.equal(
      (await request(fixture, '/v1/transfers/batch-1')).json.error.code,
      'result-unknown',
    )
    assert.equal(
      (
        await request(fixture, '/v1/transfers/downloads', {
          method: 'POST',
          value: { ...fixture.request, transferId: 'next-id' },
        })
      ).json.error.code,
      'busy',
    )
    await assert.rejects(
      fixture.service.stop(),
      (error) => error.operationError.code === 'cleanup-failed',
    )
    assert.equal(fixture.service.getAddress(), null)
  } finally {
    fault.blocked = false
    await fixture.service.stop()
  }
  assert.deepEqual(await readdir(fixture.cacheRoot), ['cache-root.json'])
})

test('JSON 精确等于字节上限允许，chunked 尾随 trailer 拒绝且不占用 ID', async (t) => {
  const fixture = await setup(t)
  const body = Buffer.from(JSON.stringify(fixture.request))
  const response = await raw(
    fixture,
    `POST /v1/transfers/downloads HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nX-Sync-Session-Id: ${fixture.address.sessionId}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n${body.length.toString(16)}\r\n${body.toString('utf8')}\r\n0\r\nX-Hidden: unexpected\r\n\r\n`,
  )
  assert.match(response, /^HTTP\/1\.1 400/)
  const exact = Buffer.concat([body, Buffer.alloc(BATCH_LIMITS.maxJsonBytes - body.length, 32)])
  const accepted = await request(fixture, '/v1/transfers/downloads', {
    method: 'POST',
    rawBody: exact,
  })
  assert.equal(accepted.status, 202)
  assert.equal((await waitState(fixture)).stage, 'ready')
})

test('准备阶段不能领取清单/content，取消信号终结原生 worker 后才返回 cancelled', async (t) => {
  const capture = { aborted: false }
  const fixture = await setup(t, {
    wrapArchive: (archive) => ({
      retryCleanup: () => archive.retryCleanup(),
      prepare: async (value, options) => {
        void value
        await new Promise((resolve, reject) => {
          void resolve
          const abort = () => {
            capture.aborted = true
            reject(new ArchiveCancelledError())
          }
          if (options.signal.aborted) abort()
          else options.signal.addEventListener('abort', abort, { once: true })
        })
        throw new Error('不应到达')
      },
    }),
  })
  await request(fixture, '/v1/transfers/downloads', { method: 'POST', value: fixture.request })
  for (const suffix of ['manifest', 'content'])
    assert.equal(
      (await request(fixture, `/v1/transfers/batch-1/${suffix}`)).json.error.code,
      'task-conflict',
    )
  await request(fixture, '/v1/transfers/batch-1', { method: 'DELETE' })
  const terminal = await waitState(fixture, (state) => state.status !== 'running')
  assert.equal(capture.aborted, true)
  assert.equal(terminal.status, 'cancelled')
})

test('停止服务中断正在发送的 HTTP，关闭流并完成缓存清理后才释放监听端口', async (t) => {
  const capture = {}
  const fixture = await setup(t, { wrapArchive: (archive) => partialArchive(archive, capture) })
  await request(fixture, '/v1/transfers/downloads', { method: 'POST', value: fixture.request })
  await waitState(fixture)
  const result = request(fixture, '/v1/transfers/batch-1/content').then(
    (value) => ({ value }),
    (error) => ({ error }),
  )
  await waitState(
    fixture,
    (state) => state.stage === 'transferring' && state.progress.archiveBytesTransferred === 1,
  )
  await fixture.service.stop()
  assert.ok((await result).error)
  assert.equal(capture.stream.destroyed, true)
  assert.deepEqual(await readdir(fixture.cacheRoot), ['cache-root.json'])
  const next = fixture.create()
  assert.equal((await next.start({ port: fixture.address.port })).port, fixture.address.port)
})

test('多个原生监听实例仍共享进程活动名额，清理后才允许另一会话接纳', async (t) => {
  const fixture = await setup(t)
  const extra = fixture.create()
  const second = {
    address: await extra.start(),
    request: { ...fixture.request, transferId: 'another-session' },
  }
  assert.equal(
    (await request(fixture, '/v1/transfers/downloads', { method: 'POST', value: fixture.request }))
      .status,
    202,
  )
  assert.equal(
    (await request(second, '/v1/transfers/downloads', { method: 'POST', value: second.request }))
      .json.error.code,
    'busy',
  )
  await waitState(fixture)
  await request(fixture, '/v1/transfers/batch-1', { method: 'DELETE' })
  await waitState(fixture, (state) => state.status !== 'running')
  assert.equal(
    (await request(second, '/v1/transfers/downloads', { method: 'POST', value: second.request }))
      .status,
    202,
  )
})
