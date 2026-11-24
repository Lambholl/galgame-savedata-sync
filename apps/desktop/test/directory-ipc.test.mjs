import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import test from 'node:test'
import { createDirectoryBridge, DIRECTORY_CHANNELS } from '../src/bridge/directory-bridge.ts'
import { createDirectoryAdapter } from '../src/backend/directory-adapter.ts'
import { registerDirectoryIpc } from '../src/backend/directory-ipc.ts'

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
  registerDirectoryIpc(
    {
      handle: (channel, handler) => handlers.set(channel, handler),
      removeHandler: (channel) => handlers.delete(channel),
    },
    adapter,
    async () => {
      selections += 1
      return selectedPath
    },
  )
  const invoke = async (channel, ...args) => handlers.get(channel)(...args)
  return {
    adapter,
    root,
    invoke,
    cancel: () => {
      selectedPath = null
    },
    selections: () => selections,
  }
}

test('选择目录的结果不带路径，再次选择时取消不清空已登记的目录', async (t) => {
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
})

test('通道拒绝路径走私及附加参数，拒绝发生在打开选择器前', async (t) => {
  const state = await fixture(t)
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
  assert.equal(state.selections(), 0)
})
