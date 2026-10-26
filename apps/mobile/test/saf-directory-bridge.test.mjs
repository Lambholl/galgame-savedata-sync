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
