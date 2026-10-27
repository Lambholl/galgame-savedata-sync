import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import test from 'node:test'
import { createDirectoryBridge, DIRECTORY_CHANNELS } from '../src/bridge/directory-bridge.ts'
import { createDirectoryAdapter } from '../src/main/directory-adapter.ts'
import { registerDirectoryIpc } from '../src/main/directory-ipc.ts'

async function fixture(t) {
  const temporaryRoot = await realpath(tmpdir())
  const base = await mkdtemp(join(temporaryRoot, 'savedata-ipc-test-'))
  t.after(async () => {
    const child = relative(temporaryRoot, base)
    assert.ok(child && !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
    assert.ok(base.includes('savedata-ipc-test-'))
    await rm(base, { recursive: true, force: true })
  })
  const root = join(base, 'files')
  await mkdir(root)
  await writeFile(join(root, 'save.sav'), 'fixture')
  const adapter = await createDirectoryAdapter(join(base, 'control', 'config.json'))
  const handlers = new Map()
  let selectedPath = root
  let selections = 0
  const dispose = registerDirectoryIpc(
    {
      handle: (channel, handler) => handlers.set(channel, handler),
      removeHandler: (channel) => handlers.delete(channel),
    },
    adapter,
    {
      choosePath: async () => {
        selections += 1
        return selectedPath
      },
      isTrustedSender: (event) => event.isTrusted === true,
    },
  )
  const invoke = async (channel, ...args) => handlers.get(channel)({ isTrusted: true }, ...args)
  return {
    adapter,
    root,
    handlers,
    invoke,
    dispose,
    cancel: () => {
      selectedPath = null
    },
    selections: () => selections,
  }
}

test('有限桥可选择和恢复目录，取消不清空既有配置；没有原始 invoke 或写入方法', async (t) => {
  const state = await fixture(t)
  const bridge = createDirectoryBridge(state.invoke)
  const selected = await bridge.chooseDirectory()
  assert.equal(selected.status, 'selected')
  assert.equal('path' in selected.directory, false)
  assert.equal((await bridge.listRoots()).value.length, 1)
  const listing = await bridge.listDirectory(selected.directory.rootId)
  assert.equal(listing.value.entries.length, 1)
  state.cancel()
  assert.deepEqual(await bridge.chooseDirectory(), { status: 'cancelled' })
  assert.equal((await bridge.listRoots()).value.length, 1)
  assert.equal(Object.isFrozen(bridge), true)
  assert.deepEqual(Object.keys(bridge).sort(), ['chooseDirectory', 'listDirectory', 'listRoots'])
  state.dispose()
  assert.equal(state.handlers.size, 0)
})

test('IPC 拒绝不可信页面、路径走私及附加参数，拒绝发生在打开选择器前', async (t) => {
  const state = await fixture(t)
  for (const channel of Object.values(DIRECTORY_CHANNELS)) {
    const denied = await state.handlers.get(channel)({ isTrusted: false })
    assert.equal(denied.error.code, 'permission-denied')
  }
  assert.equal(state.selections(), 0)
  assert.equal(
    (await state.invoke(DIRECTORY_CHANNELS.choose, state.root)).error.code,
    'invalid-request',
  )
  assert.equal(
    (await state.invoke(DIRECTORY_CHANNELS.roots, { path: state.root })).error.code,
    'invalid-request',
  )
  assert.equal(
    (
      await state.invoke(DIRECTORY_CHANNELS.list, {
        rootId: 'root-1',
        parentId: null,
        path: state.root,
      })
    ).error.code,
    'invalid-request',
  )
  assert.equal(
    (await state.invoke(DIRECTORY_CHANNELS.list, { rootId: '../outside', parentId: null })).error
      .code,
    'invalid-request',
  )
})

test('preload 拒绝畸形返回和连接失败，非法引用不发 IPC 请求', async () => {
  let requests = 0
  const malformed = createDirectoryBridge(async () => {
    requests += 1
    return { status: 'success', value: [] }
  })
  assert.equal((await malformed.chooseDirectory()).error.code, 'io-failure')
  assert.equal((await malformed.listDirectory('root-1')).error.code, 'io-failure')
  assert.equal((await malformed.listDirectory('../outside')).error.code, 'invalid-request')
  assert.equal(requests, 2)
  const disconnected = createDirectoryBridge(async () => {
    throw new Error('private message')
  })
  assert.equal((await disconnected.chooseDirectory()).error.code, 'io-failure')
  assert.equal((await disconnected.listRoots()).error.code, 'io-failure')
  assert.equal((await disconnected.listDirectory('root-1')).error.code, 'io-failure')
})
