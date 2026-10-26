import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createHttpTransferBridge } from '../src/http-transfer-bridge.ts'
import { BATCH_LIMITS } from '../../../packages/shared/src/index.ts'

const fixture = JSON.parse(
  readFileSync(new URL('../../desktop/test/fixtures/archive-v1.json', import.meta.url), 'utf8'),
)
function setup(upload = false) {
  const manifest = structuredClone(fixture.manifest)
  const targetRootId = 'target-root'
  const targets = manifest.files.map((file, index) => ({
    fileId: file.fileId,
    parentId: null,
    name: `target-${index}.sav`,
  }))
  const options = {
    request: {
      protocolVersion: 1,
      transferId: manifest.transferId,
      sourceRootId: manifest.sourceRootId,
      files: manifest.files.map((file) => ({ fileId: file.fileId, entryId: file.sourceEntryId })),
    },
    targetRootId,
    targets,
  }
  const state = {
    transferId: manifest.transferId,
    direction: upload ? 'android-to-windows' : 'windows-to-android',
    role: upload ? 'sender' : 'receiver',
    updatedAt: 1,
    status: upload ? 'sent' : 'succeeded',
    error: null,
    cleanupStatus: 'complete',
    cleanupError: null,
    fileResults: upload
      ? null
      : manifest.files.map((file, index) => ({
        fileId: file.fileId,
        status: 'succeeded',
        bytesWritten: file.sizeBytes,
        sha256: file.sha256,
        entry: {
          rootId: targetRootId,
          entryId: `published-${index}`,
          parentId: null,
          name: targets[index].name,
          kind: 'file',
          sizeBytes: file.sizeBytes,
          modifiedAt: null,
          capabilities: {
            canRead: 'supported',
            canList: 'unsupported',
            canCreate: 'unsupported',
            canRename: 'unsupported',
            canDelete: 'unsupported',
          },
        },
      })),
  }
  const calls = []
  let callback,
    removed = false
  const ok = (value) => ({ status: 'success', value })
  const plugin = {
    connect: async () =>
      ok({
        device: {
          protocolVersion: 1,
          deviceId: manifest.sourceDeviceId,
          displayName: '电脑',
          platform: 'windows',
          capabilities: {
            canListRoots: 'supported',
            canReadFiles: 'supported',
            canReceiveFiles: 'supported',
            canQueryTransfers: 'supported',
            canCancelTransfers: 'supported',
          },
        },
        sessionId: 'session-1',
        limits: BATCH_LIMITS,
      }),
    disconnect: async () => ok(null),
    chooseTarget: async () => ({ status: 'cancelled' }),
    listRemoteRoots: async () => ok([]),
    listRemoteDirectory: async (args) => ok({ ...args, observedAt: 1, entries: [] }),
    startDownload: async (args) => {
      calls.push(args)
      return ok({ transferId: args.request.transferId })
    },
    startUpload: async (args) => {
      calls.push(args)
      return ok({ transferId: args.request.transferId })
    },
    query: async () => ok(state),
    queryRemote: async () => ok({ ...state, role: upload ? 'receiver' : 'sender' }),
    getManifest: async () => ok(manifest),
    cancel: async () => ok(null),
    retryCleanup: async () => ok(true),
    addListener: async (event, handler) => {
      assert.equal(event, 'transferState')
      callback = handler
      return {
        remove: async () => {
          removed = true
        },
      }
    },
  }
  const api = createHttpTransferBridge(plugin, () => true)
  return {
    api,
    plugin,
    options,
    manifest,
    state,
    calls,
    emit: (value) => callback(value),
    removed: () => removed,
  }
}
test('下载桥将最终成功与本次文件、哈希和目标逐项匹配', async () => {
  const f = setup()
  assert.equal((await f.api.connect('http://192.168.1.2:80')).status, 'success')
  assert.equal((await f.api.startDownload(f.options)).status, 'success')
  assert.equal((await f.api.query(f.manifest.transferId)).value.status, 'succeeded')
  f.state.fileResults[1].entry.name = 'wrong.sav'
  assert.equal((await f.api.query(f.manifest.transferId)).error.code, 'io-failure')
})
test('拒绝非法选择与附加字段，建立上下文时复制输入', async () => {
  const f = setup()
  const malformed = { ...f.options, path: 'content://invalid' }
  assert.equal((await f.api.startDownload(malformed)).error.code, 'invalid-request')
  assert.equal(f.calls.length, 0)
  await f.api.connect('http://192.168.1.2')
  await f.api.startDownload(f.options)
  f.options.targets[0].name = 'caller-changed.sav'
  assert.notEqual(f.calls[0].targets[0].name, f.options.targets[0].name)
  assert.equal((await f.api.query(f.manifest.transferId)).status, 'success')
})
test('清单篡改、错任务响应和原生异常均返回脱敏失败', async () => {
  const f = setup()
  await f.api.connect('http://192.168.1.2')
  await f.api.startDownload(f.options)
  f.manifest.sourceRootId = 'other-root'
  assert.equal((await f.api.getManifest(f.options.request.transferId)).error.code, 'io-failure')
  f.plugin.query = async () => {
    throw new Error('secret local URI')
  }
  const result = await f.api.query(f.options.request.transferId)
  assert.equal(result.error.code, 'io-failure')
  assert.ok(!JSON.stringify(result).includes('secret'))
})
test('订阅验证实际结果并在 remove 后停止通知', async () => {
  const f = setup()
  await f.api.connect('http://192.168.1.2')
  await f.api.startDownload(f.options)
  const notifications = []
  const result = await f.api.subscribe((value) => notifications.push(value))
  assert.equal(result.status, 'success')
  f.emit(f.state)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(notifications[0].value.status, 'succeeded')
  await result.value.remove()
  assert.equal(f.removed(), true)
  f.emit(f.state)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(notifications.length, 1)
})
