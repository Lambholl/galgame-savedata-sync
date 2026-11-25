import assert from 'node:assert/strict'
import test from 'node:test'
import { migrateData } from '../src/index.ts'

// 版本 1 是基线，1→2 给 name 加前缀，2→3 加 tags；当前格式要求有 tags 数组。
const CHAIN = {
  baseVersion: 1,
  currentVersion: 3,
  steps: {
    1: (value) => {
      if (typeof value.name !== 'string') {
        throw new Error('name is missing')
      }
      return { ...value, schemaVersion: 2, name: `game-${value.name}` }
    },
    2: (value) => ({ ...value, schemaVersion: 3, tags: [] }),
  },
}
const isCurrent = (value) => value.schemaVersion === 3 && Array.isArray(value.tags)

test('旧版本逐步迁移到当前版本，不修改传入的数据', () => {
  const saved = { schemaVersion: 1, name: 'a' }
  assert.deepEqual(migrateData(saved, CHAIN, isCurrent), {
    status: 'migrated',
    value: { schemaVersion: 3, name: 'game-a', tags: [] },
    fromVersion: 1,
  })
  assert.deepEqual(saved, { schemaVersion: 1, name: 'a' })
})

test('当前版本只校验，更新版本报 newer', () => {
  const current = { schemaVersion: 3, name: 'a', tags: [] }
  assert.deepEqual(migrateData(current, CHAIN, isCurrent), { status: 'current', value: current })
  assert.deepEqual(migrateData({ schemaVersion: 3 }, CHAIN, isCurrent), { status: 'unreadable' })
  assert.deepEqual(migrateData({ schemaVersion: 4 }, CHAIN, isCurrent), { status: 'newer' })
})

test('低于基线的版本、没有整数版本号和迁移失败都按读不懂处理', () => {
  for (const saved of [
    { schemaVersion: 0, name: 'a' },
    { schemaVersion: 1.5, name: 'a' },
    { name: 'a' },
    [],
    'text',
    // 第一步抛错。
    { schemaVersion: 1 },
  ]) {
    assert.deepEqual(migrateData(saved, CHAIN, isCurrent), { status: 'unreadable' }, saved)
  }
  const wrongVersion = { ...CHAIN, steps: { ...CHAIN.steps, 2: (value) => value } }
  assert.deepEqual(migrateData({ schemaVersion: 2, name: 'a' }, wrongVersion, isCurrent), {
    status: 'unreadable',
  })
  const invalidResult = { ...CHAIN, steps: { ...CHAIN.steps, 2: () => ({ schemaVersion: 3 }) } }
  assert.deepEqual(migrateData({ schemaVersion: 2 }, invalidResult, isCurrent), {
    status: 'unreadable',
  })
})
