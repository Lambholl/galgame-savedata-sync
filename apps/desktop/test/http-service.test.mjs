import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import test from 'node:test'
import { BATCH_LIMITS } from '@savedata-sync/shared'
import { createDirectoryAdapter } from '../src/backend/directory-adapter.ts'
import { WindowsHttpService } from '../src/backend/http-service.ts'

const unwrap = (result) => {
  assert.equal(result.status, 'success', JSON.stringify(result))
  return result.value
}

async function setup(t) {
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
  await mkdir(root)
  await mkdir(join(root, '子目录'))
  await writeFile(join(root, '源 %.sav'), Buffer.from('真实 HTTP 合成存档 😀'))
  const source = await createDirectoryAdapter(join(base, 'control', 'directories.json'))
  const selected = unwrap(await source.registerDirectory(root))
  const service = new WindowsHttpService(source)
  services.push(service)
  const address = await service.start()
  return { base, source, selected, service, address }
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

test('设备/根/当前层通过真实 HTTP 返回公开 DTO，会话与目录边界分开', async (t) => {
  const fixture = await setup(t)
  const device = await request(fixture, '/v1/device', { session: false })
  assert.equal(device.status, 200)
  const descriptor = unwrap(device.json)
  assert.equal(descriptor.device.deviceId, fixture.source.deviceId)
  assert.equal(descriptor.device.protocolVersion, 3)
  assert.equal(descriptor.device.capabilities.canListRoots, 'supported')
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

test('重启服务保留设备但更换会话，旧会话的请求被拒绝', async (t) => {
  const fixture = await setup(t)
  const previous = fixture.address
  await Promise.all([fixture.service.stop(), fixture.service.stop()])
  assert.equal(fixture.service.getAddress(), null)
  fixture.address = await fixture.service.start({ port: previous.port })
  assert.notEqual(fixture.address.sessionId, previous.sessionId)
  const device = unwrap((await request(fixture, '/v1/device')).json)
  assert.equal(device.device.deviceId, fixture.source.deviceId)
  assert.equal(
    (await request(fixture, '/v1/roots', { headers: { 'x-sync-session-id': previous.sessionId } }))
      .status,
    409,
  )
})
