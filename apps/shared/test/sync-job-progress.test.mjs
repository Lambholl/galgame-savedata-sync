import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SYNC_JOB_SCHEMA_VERSION,
  isSyncJobDigest,
  isSyncJobProgress,
  observeSyncJob,
  syncJobBackupBytes,
} from '../src/index.ts'

function progress(overrides = {}) {
  return {
    transferredBytes: 4000,
    totalFileBytes: 4000,
    totalFiles: 2,
    publishedFiles: 0,
    fileBytesPublished: 0,
    backupBytesCopied: 0,
    totalBackupBytes: 10000,
    ...overrides,
  }
}

function state(role, overrides = {}, progressOverrides = {}) {
  return {
    schemaVersion: SYNC_JOB_SCHEMA_VERSION,
    jobId: 'job-1',
    direction: 'windows-to-android',
    role,
    status: 'running',
    stage: 'backing-up',
    updatedAt: 1,
    cancelRequested: false,
    progress: progress(progressOverrides),
    failureStage: null,
    error: null,
    cleanupError: null,
    result: null,
    ...overrides,
  }
}

test('备份阶段按接收端已复制的备份字节算百分比', () => {
  const sender = { ...state('sender'), status: 'sent', stage: 'done' }
  const receiver = state('receiver', {}, { backupBytesCopied: 2500 })
  for (const [local, remote] of [
    [receiver, sender],
    [sender, receiver],
  ]) {
    const observation = observeSyncJob(local, remote, false)
    assert.equal(observation.stage, 'backing-up')
    assert.equal(observation.step, 0)
    assert.equal(observation.percent, 25)
    assert.equal(observation.counters.completedBytes, 2500)
    assert.equal(observation.counters.totalBytes, 10000)
  }
})

test('没有要备份的字节时备份阶段百分比未知', () => {
  const receiver = state('receiver', {}, { totalBackupBytes: 0 })
  assert.equal(observeSyncJob(receiver, null, false).percent, null)
})

test('备份字节数不能超过总量，发送端不能有备份进度', () => {
  assert.equal(isSyncJobProgress(progress({ backupBytesCopied: 10000 })), true)
  assert.equal(isSyncJobProgress(progress({ backupBytesCopied: 10001 })), false)
  assert.equal(isSyncJobProgress({ ...progress(), backupBytesCopied: undefined }), false)
  const withoutTotal = progress()
  delete withoutTotal.totalBackupBytes
  assert.equal(isSyncJobProgress(withoutTotal), false)
  assert.equal(isSyncJobDigest(withoutResult(state('receiver'))), true)
  assert.equal(isSyncJobDigest(withoutResult(state('sender'))), true)
  assert.equal(isSyncJobDigest(withoutResult(state('sender', {}, { backupBytesCopied: 1 }))), false)
})

test('旧版本的任务状态被拒绝', () => {
  assert.equal(isSyncJobDigest(withoutResult(state('receiver', { schemaVersion: 2 }))), false)
})

test('任务的备份总量取计划的 backupFileBytes，未知时为 0', () => {
  assert.equal(syncJobBackupBytes({ backupFileBytes: 123 }), 123)
  assert.equal(syncJobBackupBytes({ backupFileBytes: null }), 0)
})

function withoutResult(value) {
  const digest = { ...value }
  delete digest.result
  return digest
}
