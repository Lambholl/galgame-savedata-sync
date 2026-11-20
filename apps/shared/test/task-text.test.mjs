import assert from 'node:assert/strict'
import test from 'node:test'
import { SYNC_JOB_SCHEMA_VERSION, createTranslator, observeSyncJob } from '../src/index.ts'
import { countOutcomes } from '../src/ui/task/outcomes.ts'
import { restoreTaskPreview, syncTaskPreview } from '../src/ui/task/task-presentation.ts'

const LOCALES = ['zh-CN', 'zh-TW', 'en-US', 'ja-JP']

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
      sourceBytesRead: 0,
      archiveBytesTransferred: 0,
      fileBytesVerified: 0,
      fileBytesPublished: 0,
      totalFileBytes: 0,
      totalArchiveBytes: 0,
      totalFiles: 0,
      verifiedFiles: 0,
      publishedFiles: 0,
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

// 返回文案键本身，断言选了哪条文案，不依赖措辞。
const keyOnly = (key) => key

function includesAll(status, keys) {
  return keys.every((key) => status.includes(key))
}

test('任务条：失败又清理失败时两件事都写，成功但清理失败时写清理失败', () => {
  const base = { stage: 'done', step: 4, percent: null }
  const failed = syncTaskPreview({ ...base, phase: 'failed', hasCleanupError: true }, keyOnly)
  assert.ok(includesAll(failed.status, ['task.failed', 'task.cleanupFailed']))
  assert.equal(failed.phase, 'failed')
  const done = syncTaskPreview({ ...base, phase: 'done', hasCleanupError: true }, keyOnly)
  assert.deepEqual([done.status, done.phase], ['task.cleanupFailed', 'partial'])
  const restore = restoreTaskPreview('failed', true, keyOnly)
  assert.ok(includesAll(restore.status, ['backup.restoreFailed', 'task.cleanupFailed']))
  assert.equal(restore.phase, 'failed')
})

test('任务条：等待对方设备开始时不写正在准备', () => {
  const running = { phase: 'running', stage: 'preparing', step: 0, percent: null }
  const preview = (isAwaitingPeer) =>
    syncTaskPreview({ ...running, hasCleanupError: false, isAwaitingPeer }, keyOnly).status
  assert.equal(preview(true), 'task.awaitingPeer')
  assert.equal(preview(false), 'task.stage.preparing')
})

test('四种语言的部分完成只列不为 0 的类别', () => {
  for (const locale of LOCALES) {
    const t = createTranslator(locale)
    const only = t('task.partialDetail', { succeeded: 3, failed: 0, unknown: 0, skipped: 0 })
    const all = t('task.partialDetail', { succeeded: 3, failed: 1, unknown: 2, skipped: 4 })
    assert.equal(only.split(' · ').length, 1, locale)
    assert.equal(all.split(' · ').length, 4, locale)
    for (const number of ['3', '1', '2', '4']) {
      assert.ok(all.includes(number), `${locale}: ${all}`)
    }
  }
})
