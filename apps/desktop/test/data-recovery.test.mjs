import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DATA_RESET_ITEMS, LIBRARY_SCHEMA_VERSION } from '@savedata-sync/shared'
import { NewerDataError, setAsideUnreadableData } from '../src/backend/data-recovery.ts'

async function createFixture(t) {
  const base = await mkdtemp(join(await realpath(tmpdir()), 'savedata-recovery-test-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const paths = Object.fromEntries(
    DATA_RESET_ITEMS.map((item) => [item, join(base, `${item}.json`)]),
  )
  return { base, paths }
}

test('有数据由更新版本写入时报告这些数据项，所有文件都不改名', async (t) => {
  const { base, paths } = await createFixture(t)
  const newer = JSON.stringify({ schemaVersion: LIBRARY_SCHEMA_VERSION + 1, games: 'future' })
  await writeFile(paths.library, newer)
  await writeFile(paths['device-identity'], 'not json')

  await assert.rejects(setAsideUnreadableData(paths), (error) => {
    assert.ok(error instanceof NewerDataError)
    assert.deepEqual(error.items, ['library'])
    return true
  })
  assert.equal(await readFile(paths.library, 'utf8'), newer)
  assert.deepEqual((await readdir(base)).sort(), ['device-identity.json', 'library.json'])
})

test('旧版本和损坏的文件改名保留，界面偏好里不认识的字段不算读不懂', async (t) => {
  const { base, paths } = await createFixture(t)
  await writeFile(paths.library, JSON.stringify({ schemaVersion: 1, games: [], devices: [] }))
  await writeFile(paths['service-settings'], '[]')
  await writeFile(
    paths.preferences,
    JSON.stringify({ theme: 'sepia', locale: 'en-US', fontSize: 2 }),
  )

  assert.deepEqual(await setAsideUnreadableData(paths), ['library', 'service-settings'])
  const names = await readdir(base)
  assert.ok(names.includes('preferences.json'))
  assert.equal(names.filter((name) => name.includes('.unreadable-')).length, 2)
})
