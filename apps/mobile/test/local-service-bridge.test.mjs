import assert from 'node:assert/strict'
import test from 'node:test'
import { createLocalService } from '../src/platform/local-service-bridge.ts'

const status = {
  deviceId: 'phone-a',
  configuredPort: 50123,
  isEnabled: true,
  listener: { port: 50123, startedAt: 1 },
  ipv4Addresses: ['192.168.1.20'],
  discovery: 'advertising',
  error: null,
  peerId: 'phone-b',
}
const root = {
  rootId: 'root-b',
  deviceId: 'phone-b',
  displayName: 'Saves',
  authorization: 'granted',
}
const peer = {
  deviceId: 'phone-b',
  name: 'Phone B',
  platform: 'android',
  isOpen: true,
  games: [{ id: 'game-b', name: 'B', root }],
}

function fixture(overrides = {}) {
  const handlers = new Map()
  const calls = []
  const plugin = {
    status: async () => ({ status: 'success', value: status }),
    start: async () => ({ status: 'success', value: status }),
    stop: async () => ({
      status: 'success',
      value: { ...status, listener: null, ipv4Addresses: [] },
    }),
    randomizePort: async () => ({ status: 'success', value: status }),
    peers: async () => ({ status: 'success', value: [peer] }),
    disconnectPeer: async (options) => {
      calls.push(options)
      return { status: 'success', value: null }
    },
    peerDirectory: async (options) => {
      calls.push(options)
      return {
        status: 'success',
        value: { rootId: options.rootId, parentId: options.parentId, observedAt: 1, entries: [] },
      }
    },
    catalogChanged: async () => ({ status: 'success', value: null }),
    addListener: async (event, callback) => {
      handlers.set(event, callback)
      return { remove: async () => undefined }
    },
    ...overrides,
  }
  return { plugin, handlers, calls }
}

test('本机服务桥接返回格式正确的原生结果，并把参数原样交给原生方法', async () => {
  const { plugin, calls } = fixture()
  const service = createLocalService(plugin, () => true)
  assert.deepEqual(await service.status(), { status: 'success', value: status })
  assert.equal((await service.stop()).status, 'success')
  assert.deepEqual(await service.peers(), { status: 'success', value: [peer] })
  assert.equal((await service.peerDirectory('phone-b', 'root-b', null)).status, 'success')
  assert.equal((await service.disconnectPeer('phone-b')).status, 'success')
  assert.deepEqual(calls, [
    { deviceId: 'phone-b', rootId: 'root-b', parentId: null },
    { deviceId: 'phone-b' },
  ])
})

test('本机服务桥接拒绝无效的目录 ID，不调用原生方法', async () => {
  const { plugin, calls } = fixture()
  const service = createLocalService(plugin, () => true)
  const invalid = await service.peerDirectory('phone-b', '../root', null)
  assert.equal(invalid.status === 'error' && invalid.error.code, 'invalid-request')
  assert.equal(calls.length, 0)
})

test('本机服务桥接拒绝格式不对或与请求不符的原生结果', async () => {
  const cases = [
    { status: async () => ({ status: 'success', value: { ...status, discovery: 'paused' } }) },
    { status: async () => ({ status: 'success', value: { ...status, ipv4Addresses: ['::1'] } }) },
    {
      status: async () => ({
        status: 'success',
        value: { ...status, listener: { port: 0, startedAt: 1 } },
      }),
    },
    { status: async () => Promise.reject(new Error('closed')) },
  ]
  for (const overrides of cases) {
    const result = await createLocalService(fixture(overrides).plugin, () => true).status()
    assert.equal(result.status === 'error' && result.error.code, 'io-failure')
  }
  const peers = await createLocalService(
    fixture({
      peers: async () => ({ status: 'success', value: [{ ...peer, platform: 'ios' }] }),
    }).plugin,
    () => true,
  ).peers()
  assert.equal(peers.status === 'error' && peers.error.code, 'io-failure')
  const moved = await createLocalService(
    fixture({
      peerDirectory: async () => ({
        status: 'success',
        value: { rootId: 'root-b', parentId: 'other', observedAt: 1, entries: [] },
      }),
    }).plugin,
    () => true,
  ).peerDirectory('phone-b', 'root-b', null)
  assert.equal(moved.status === 'error' && moved.error.code, 'io-failure')
})

test('本机服务桥接转发原生事件，撤销订阅后不再通知', async () => {
  const { plugin, handlers } = fixture()
  const service = createLocalService(plugin, () => true)
  let states = 0
  let changes = 0
  const stopState = service.onState(() => states++)
  service.onLibraryChanged(() => changes++)
  await Promise.resolve()
  handlers.get('serviceState')()
  handlers.get('libraryChanged')()
  stopState()
  handlers.get('serviceState')()
  assert.deepEqual([states, changes], [1, 1])
})

test('本机服务桥接不在 Android 上时返回 unsupported-operation，不订阅原生事件', async () => {
  const browser = fixture()
  const unavailable = createLocalService(browser.plugin, () => false)
  unavailable.onState(() => undefined)
  const result = await unavailable.start()
  assert.equal(result.status === 'error' && result.error.code, 'unsupported-operation')
  assert.equal(browser.handlers.size, 0)
})
