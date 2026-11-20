import assert from 'node:assert/strict'
import test from 'node:test'
import { SYNC_JOB_SCHEMA_VERSION, observeSyncJob } from '../src/index.ts'
import { countOutcomes } from '../src/ui/task/outcomes.ts'

function outcome(path, action, status) {
  return { path: [path], action, status, sizeBytes: null, error: null }
}

function state(role, overrides = {}) {
  return {
    schemaVersion: SYNC_JOB_SCHEMA_VERSION,
    jobId: 'job-1',
    direction: 'listener-to-dialer',
    role,
    status: 'failed',
    stage: 'done',
    updatedAt: 1,
    isCancelRequested: false,
    progress: {
      transferredBytes: 0,
      totalFileBytes: 0,
      totalFiles: 0,
      publishedFiles: 0,
      fileBytesPublished: 0,
      backupBytesCopied: 0,
      totalBackupBytes: 0,
    },
    failureStage: 'writing',
    error: null,
    cleanupError: null,
    result: null,
    ...overrides,
  }
}

function receiverWith(status, outcomes) {
  return state('receiver', {
    status,
    result: {
      schemaVersion: 1,
      planId: 'job-1',
      backupId: null,
      backupFileCount: null,
      outcomes,
      error: null,
      cleanupError: null,
    },
  })
}

test('写入结果把文件、文件夹、删除分开计数，取消时没执行的不算失败', () => {
  const counts = countOutcomes([
    outcome('a', 'create-file', 'succeeded'),
    outcome('b', 'replace-file', 'succeeded'),
    outcome('c', 'create-directory', 'succeeded'),
    outcome('d', 'delete-file', 'succeeded'),
    outcome('e', 'create-file', 'failed'),
    outcome('f', 'create-file', 'unknown'),
    outcome('g', 'create-file', 'cancelled'),
    outcome('h', 'create-file', 'not-attempted'),
  ])
  assert.deepEqual(counts, {
    files: 2,
    folders: 1,
    deleted: 1,
    succeeded: 4,
    failed: 1,
    unknown: 1,
    skipped: 2,
  })
})

test('接收端结果待确认时，有成功项也算结果待确认', () => {
  const sender = state('sender', { status: 'sent', failureStage: null })
  const items = [outcome('a', 'create-file', 'succeeded'), outcome('b', 'create-file', 'unknown')]
  assert.equal(observeSyncJob(sender, receiverWith('unknown', items), false).phase, 'unknown')
  assert.equal(observeSyncJob(sender, receiverWith('failed', items), false).phase, 'partial')
})
