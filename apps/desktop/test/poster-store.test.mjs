import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PosterStore } from '../src/backend/poster-store.ts'

// 各格式只要文件开头的标识字节对，后面的内容不影响存取。
const IMAGES = {
  webp: Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.alloc(4),
    Buffer.from('WEBPVP8 '),
    Buffer.from([1, 2]),
  ]),
  jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]),
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]),
}

const sha256 = (content) => createHash('sha256').update(content).digest('hex')
const hasCode = (code) => (error) => error.operationError?.code === code

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'savedata-poster-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return { directory, store: new PosterStore(directory) }
}

for (const [format, image] of Object.entries(IMAGES)) {
  test(`${format} 封面存入后按 hash 读出原内容`, async (t) => {
    const { store } = await setup(t)
    const posterHash = await store.save('game-1', image.toString('base64'))
    assert.equal(posterHash, sha256(image))
    assert.deepEqual(Buffer.from(await store.read('game-1', posterHash), 'base64'), image)
  })
}

test('不是 WebP、JPEG、PNG 的内容不保存', async (t) => {
  const { directory, store } = await setup(t)
  await assert.rejects(
    store.save('game-1', Buffer.from('GIF89a').toString('base64')),
    hasCode('invalid-request'),
  )
  assert.deepEqual(await readdir(directory), [])
})

test('以前存下的 .webp 封面文件仍能读出', async (t) => {
  const { directory, store } = await setup(t)
  const posterHash = sha256(IMAGES.webp)
  await writeFile(join(directory, `game-1.${posterHash}.webp`), IMAGES.webp)
  assert.deepEqual(Buffer.from(await store.read('game-1', posterHash), 'base64'), IMAGES.webp)
})

test('prune 保留游戏库引用的各格式封面，删掉其余文件', async (t) => {
  const { directory, store } = await setup(t)
  const games = []
  for (const [format, image] of Object.entries(IMAGES)) {
    const id = `game-${format}`
    games.push({ id, posterHash: await store.save(id, image.toString('base64')) })
  }
  const unused = await store.save('game-unused', IMAGES.png.toString('base64'))
  await store.prune(games)
  for (const game of games) {
    await store.read(game.id, game.posterHash)
  }
  await assert.rejects(store.read('game-unused', unused), hasCode('not-found'))
  assert.equal((await readdir(directory)).length, games.length)
})
