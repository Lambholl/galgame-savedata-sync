import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EMPTY_BACKUP_SETTINGS,
  isSyncBackupSettings,
  resolveBackupPolicy,
  withBackupDefaults,
  withBackupPreference,
} from '../src/index.ts'

test('游戏目录没有单独设置时跟随全局设置', () => {
  const settings = withBackupDefaults(EMPTY_BACKUP_SETTINGS, { shouldBackup: false, keepCount: 5 })
  assert.deepEqual(resolveBackupPolicy(settings, 'game-1', 'root-1'), {
    shouldBackup: false,
    keepCount: 5,
    isCustom: false,
  })
})

test('单独设置优先于全局设置，改回跟随全局后删除记录', () => {
  const custom = withBackupPreference(EMPTY_BACKUP_SETTINGS, 'game-1', 'root-1', {
    shouldBackup: true,
    keepCount: 10,
  })
  assert.ok(isSyncBackupSettings(custom))
  assert.deepEqual(resolveBackupPolicy(custom, 'game-1', 'root-1'), {
    shouldBackup: true,
    keepCount: 10,
    isCustom: true,
  })
  assert.equal(resolveBackupPolicy(custom, 'game-1', 'root-2').isCustom, false)
  const following = withBackupPreference(custom, 'game-1', 'root-1', null)
  assert.deepEqual(following.projects, [])
})

test('修改全局设置不影响单独设置的游戏目录', () => {
  const custom = withBackupPreference(EMPTY_BACKUP_SETTINGS, 'game-1', 'root-1', {
    shouldBackup: true,
    keepCount: 2,
  })
  const changed = withBackupDefaults(custom, { shouldBackup: false, keepCount: 1 })
  assert.equal(resolveBackupPolicy(changed, 'game-1', 'root-1').keepCount, 2)
  assert.equal(resolveBackupPolicy(changed, 'game-2', 'root-1').shouldBackup, false)
})

test('保留份数超出 1–10 的设置无效', () => {
  for (const keepCount of [0, 11, 2.5]) {
    assert.equal(
      isSyncBackupSettings({
        ...EMPTY_BACKUP_SETTINGS,
        defaults: { shouldBackup: true, keepCount },
      }),
      false,
    )
  }
})

test('不认识的设置格式视为损坏', () => {
  assert.equal(isSyncBackupSettings({ schemaVersion: 1, projects: [] }), false)
  assert.equal(
    isSyncBackupSettings({
      schemaVersion: 3,
      defaults: EMPTY_BACKUP_SETTINGS.defaults,
      projects: [],
    }),
    false,
  )
})
