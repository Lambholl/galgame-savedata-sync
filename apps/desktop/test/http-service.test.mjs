import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { gunzipSync } from 'node:zlib'
import test from 'node:test'
import { BATCH_LIMITS, isBatchState, matchesBatchState } from '@savedata-sync/shared'
import { createDirectoryAdapter } from '../src/main/directory-adapter.ts'
import { createWindowsArchiveAdapter } from '../src/main/archive-adapter.ts'
import { WindowsHttpService } from '../src/main/http-service.ts'

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
    for (const service of services) {
      await service.stop()
    }
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
    if (predicate(state)) {
      return state
    }
    await sleep(5)
  }
  assert.fail('任务未在测试期限内到达预期状态')
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
  ]) {
    assert.equal(
      (await request(fixture, '/v1/transfers/downloads', { method: 'POST', value })).json.error
        .code,
      code,
    )
  }
  assert.equal(
    (await request(fixture, '/v1/transfers/downloads', { method: 'POST', value: fixture.request }))
      .status,
    202,
  )
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
