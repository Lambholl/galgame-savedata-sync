import assert from 'node:assert/strict'
import test from 'node:test'
import { createSafDirectoryBridge } from '../src/saf-directory-bridge.ts'

const root = {
  rootId: 'root-1',
  deviceId: 'device-1',
  displayName: '目录',
  authorization: 'granted',
}
const listing = { rootId: root.rootId, parentId: null, observedAt: 1, entries: [] }

function fixture() {
  let cancelled = false
  const calls = []
  const plugin = {
    chooseDirectory: async () =>
      cancelled ? { status: 'cancelled' } : { status: 'selected', directory: root },
    listRoots: async () => ({ status: 'success', value: [root] }),
    listDirectory: async (options) => {
      calls.push(options)
      return { status: 'success', value: listing }
    },
  }
  return {
    plugin,
    calls,
    cancel: () => {
      cancelled = true
    },
  }
}

test('有限桥保留取消与恢复语义，只接受目录引用，不暴露内容/写入接口', async () => {
  const state = fixture()
  const api = createSafDirectoryBridge(state.plugin, () => true)
  assert.deepEqual(await api.chooseDirectory(), { status: 'selected', directory: root })
  state.cancel()
  assert.deepEqual(await api.chooseDirectory(), { status: 'cancelled' })
  assert.deepEqual((await api.listRoots()).value, [root])
  assert.deepEqual((await api.listDirectory(root.rootId)).value, listing)
  assert.deepEqual(state.calls, [{ rootId: root.rootId, parentId: null }])
  assert.deepEqual(Object.keys(api).sort(), ['chooseDirectory', 'listDirectory', 'listRoots'])
  assert.equal(Object.isFrozen(api), true)
})

test('路径、URI、非法 parentId 在进入原生层之前拒绝', async () => {
  const state = fixture()
  const api = createSafDirectoryBridge(state.plugin, () => true)
  for (const id of ['../outside', '/storage/save', 'content://provider/root', '', 1]) {
    assert.equal((await api.listDirectory(id)).error.code, 'invalid-request')
    assert.equal((await api.listDirectory(root.rootId, id)).error.code, 'invalid-request')
  }
  assert.equal(state.calls.length, 0)
})

test('Web 预览报告不支持，不能伪造成功空目录或启动原生请求', async () => {
  const plugin = new Proxy(
    {},
    {
      get: () => {
        throw new Error('must not touch native')
      },
    },
  )
  const api = createSafDirectoryBridge(plugin, () => false)
  for (const result of [
    await api.chooseDirectory(),
    await api.listRoots(),
    await api.listDirectory(root.rootId),
  ]) {
    assert.equal(result.error.code, 'unsupported-operation')
  }
})

test('畸形返回、额外 URI、跨根响应和原生异常均脱敏失败', async () => {
  const state = fixture()
  const api = createSafDirectoryBridge(state.plugin, () => true)
  state.plugin.chooseDirectory = async () => ({
    status: 'selected',
    directory: { ...root, uri: 'private' },
  })
  assert.equal((await api.chooseDirectory()).error.code, 'io-failure')
  state.plugin.listRoots = async () => {
    throw new Error('private provider URI')
  }
  const failure = await api.listRoots()
  assert.equal(failure.error.code, 'io-failure')
  assert.equal(JSON.stringify(failure).includes('private'), false)
  state.plugin.listDirectory = async () => ({
    status: 'success',
    value: { ...listing, rootId: 'other' },
  })
  assert.equal((await api.listDirectory(root.rootId)).error.code, 'io-failure')
  state.plugin.listDirectory = async () => ({
    status: 'success',
    value: { ...listing, parentId: 'other' },
  })
  assert.equal((await api.listDirectory(root.rootId)).error.code, 'io-failure')
})

test('失效授权保持独立错误，空目录保持成功', async () => {
  const state = fixture()
  const api = createSafDirectoryBridge(state.plugin, () => true)
  assert.deepEqual((await api.listDirectory(root.rootId)).value.entries, [])
  const failure = {
    status: 'error',
    error: { code: 'authorization-expired', message: '请重新选择', canRetry: true },
  }
  state.plugin.listDirectory = async () => failure
  assert.deepEqual(await api.listDirectory(root.rootId), failure)
})
