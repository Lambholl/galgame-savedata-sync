import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BACKUP_KEEP_COUNT_MAX,
  EMPTY_BACKUP_SETTINGS,
  createSyncPlan,
  isRemoteSyncReport,
  isSyncBackupManifest,
  isSyncBackupSettings,
  isSyncManualBackupState,
  isSyncPreparationPreview,
  isSyncProjectDescriptor,
  readSyncBackupManifest,
  resolveBackupPolicy,
  withBackupDefaults,
  withBackupPreference,
} from '../src/index.ts'

test('游戏没有单独设置时跟随全局设置', () => {
  const settings = withBackupDefaults(EMPTY_BACKUP_SETTINGS, { shouldBackup: false, keepCount: 5 })
  assert.deepEqual(resolveBackupPolicy(settings, 'game-1'), {
    shouldBackup: false,
    keepCount: 5,
    isCustom: false,
  })
})

test('单独设置优先于全局设置，改回跟随全局后删除记录', () => {
  const custom = withBackupPreference(EMPTY_BACKUP_SETTINGS, 'game-1', {
    shouldBackup: true,
    keepCount: 10,
  })
  assert.ok(isSyncBackupSettings(custom))
  assert.deepEqual(resolveBackupPolicy(custom, 'game-1'), {
    shouldBackup: true,
    keepCount: 10,
    isCustom: true,
  })
  assert.equal(resolveBackupPolicy(custom, 'game-2').isCustom, false)
  const following = withBackupPreference(custom, 'game-1', null)
  assert.deepEqual(following.projects, [])
})

test('修改全局设置不影响单独设置的游戏', () => {
  const custom = withBackupPreference(EMPTY_BACKUP_SETTINGS, 'game-1', {
    shouldBackup: true,
    keepCount: 2,
  })
  const changed = withBackupDefaults(custom, { shouldBackup: false, keepCount: 1 })
  assert.equal(resolveBackupPolicy(changed, 'game-1').keepCount, 2)
  assert.equal(resolveBackupPolicy(changed, 'game-2').shouldBackup, false)
})

test('保留份数在上限内有效，超出上限或非整数的设置无效', () => {
  assert.equal(
    isSyncBackupSettings({
      ...EMPTY_BACKUP_SETTINGS,
      defaults: { shouldBackup: false, keepCount: BACKUP_KEEP_COUNT_MAX },
    }),
    true,
  )
  for (const keepCount of [0, BACKUP_KEEP_COUNT_MAX + 1, 2.5]) {
    assert.equal(
      isSyncBackupSettings({
        ...EMPTY_BACKUP_SETTINGS,
        defaults: { shouldBackup: true, keepCount },
      }),
      false,
    )
  }
})

test('同一个游戏有两条单独设置时无效', () => {
  const entry = { projectId: 'game-1', shouldBackup: true, keepCount: 2 }
  assert.equal(isSyncBackupSettings({ ...EMPTY_BACKUP_SETTINGS, projects: [entry, entry] }), false)
})

test('当前格式版本以外的设置视为损坏', () => {
  assert.equal(isSyncBackupSettings({ schemaVersion: 1, projects: [] }), false)
  for (const schemaVersion of [2, 4]) {
    assert.equal(
      isSyncBackupSettings({
        schemaVersion,
        defaults: EMPTY_BACKUP_SETTINGS.defaults,
        projects: [{ projectId: 'game-1', shouldBackup: true, keepCount: 2 }],
      }),
      false,
    )
  }
})

test('备份清单接受 copy、restore 和 manual 原因并拒绝未知原因', () => {
  const base = {
    schemaVersion: 1,
    backupId: 'backup-1',
    projectId: 'game-1',
    deviceId: 'device-1',
    rootId: 'root-1',
    createdAt: 1700000000000,
    files: [{ fileId: 'f000001', path: ['save.dat'], sizeBytes: 12, modifiedAt: 1700000000000 }],
  }
  for (const reason of ['copy', 'restore', 'manual']) {
    assert.equal(isSyncBackupManifest({ ...base, reason }), true)
    assert.ok(readSyncBackupManifest({ ...base, reason }))
  }
  assert.equal(isSyncBackupManifest({ ...base, reason: 'auto' }), false)
})

test('本机手动备份状态校验阶段、字节进度与终态关系', () => {
  const base = {
    schemaVersion: 1,
    taskId: 'manual-1',
    projectId: 'game-1',
    rootId: 'root-1',
    status: 'running',
    stage: 'scanning',
    updatedAt: 1700000000000,
    isCancelRequested: false,
    bytesCopied: 0,
    totalBytes: 0,
    backupId: null,
    fileCount: null,
    error: null,
    cleanupError: null,
  }
  const cleanupError = { code: 'cleanup-failed', message: 'Cleanup failed.', canRetry: false }
  const ioError = { code: 'io-failure', message: 'Read failed.', canRetry: true }
  assert.equal(isSyncManualBackupState(base), true)
  assert.equal(
    isSyncManualBackupState({ ...base, stage: 'backing-up', bytesCopied: 4, totalBytes: 10 }),
    true,
  )
  assert.equal(
    isSyncManualBackupState({
      ...base,
      status: 'succeeded',
      stage: 'done',
      bytesCopied: 10,
      totalBytes: 10,
      backupId: 'backup-1',
      fileCount: 2,
      cleanupError,
    }),
    true,
  )
  assert.equal(isSyncManualBackupState({ ...base, status: 'empty', stage: 'done' }), true)
  assert.equal(
    isSyncManualBackupState({
      ...base,
      status: 'cancelled',
      stage: 'done',
      isCancelRequested: true,
    }),
    true,
  )
  assert.equal(
    isSyncManualBackupState({ ...base, status: 'failed', stage: 'done', error: ioError }),
    true,
  )
  assert.equal(isSyncManualBackupState({ ...base, stage: 'scanning', totalBytes: 10 }), false)
  assert.equal(
    isSyncManualBackupState({
      ...base,
      status: 'succeeded',
      stage: 'done',
      bytesCopied: 5,
      totalBytes: 10,
      backupId: 'backup-1',
      fileCount: 1,
    }),
    false,
  )
  assert.equal(
    isSyncManualBackupState({
      ...base,
      status: 'cancelled',
      stage: 'done',
      isCancelRequested: false,
    }),
    false,
  )
})

test('跨端项目描述、准备预览与远程同步回报不包含 backupKeepCount 字段', () => {
  const descriptor = {
    schemaVersion: 1,
    projectId: 'game-1',
    deviceId: 'device-1',
    rootId: 'root-1',
    shouldBackup: true,
  }
  assert.equal(isSyncProjectDescriptor(descriptor), true)
  assert.equal(isSyncProjectDescriptor({ ...descriptor, backupKeepCount: 3 }), false)

  const snapshot = (deviceId, rootId) => ({
    schemaVersion: 1,
    scanId: `scan-${deviceId}`,
    deviceId,
    rootId,
    observedAt: 1700000000000,
    entries: [],
    error: null,
  })
  const source = snapshot('pc-1', 'root-pc')
  const target = snapshot('phone-1', 'root-phone')
  const preview = {
    schemaVersion: 1,
    preparationId: 'prep-1',
    direction: 'listener-to-dialer',
    localSide: 'dialer',
    binding: {
      projectId: 'game-phone',
      remoteProjectId: 'game-pc',
      localDeviceId: 'phone-1',
      remoteDeviceId: 'pc-1',
      localRootId: 'root-phone',
      remoteRootId: 'root-pc',
    },
    source,
    target,
    shouldBackup: false,
    shouldDeleteExtras: false,
  }
  assert.equal(isSyncPreparationPreview(preview), true)
  assert.equal(isSyncPreparationPreview({ ...preview, backupKeepCount: 3 }), false)

  const plan = createSyncPlan({
    planId: 'prep-1',
    projectId: 'game-phone',
    operation: 'copy',
    direction: 'listener-to-dialer',
    shouldBackup: false,
    shouldDeleteExtras: false,
    source,
    target,
  })
  const report = { requestId: 'req-1', status: 'ready', plan }
  assert.equal(isRemoteSyncReport(report), true)
  assert.equal(isRemoteSyncReport({ ...report, backupKeepCount: 3 }), false)
})
