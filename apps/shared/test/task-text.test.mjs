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
    direction: 'windows-to-android',
    role,
    status: 'failed',
    stage: 'done',
    updatedAt: 1,
    cancelRequested: false,
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

test('任务条：失败又清理失败时两件事都写，成功但清理失败时写清理失败', () => {
  const t = createTranslator('zh-CN')
  const base = { stage: 'done', step: 4, percent: null }
  const failed = syncTaskPreview({ ...base, phase: 'failed', hasCleanupError: true }, t)
  assert.equal(failed.status, '传输失败 · 临时文件未清理')
  assert.equal(failed.phase, 'failed')
  const done = syncTaskPreview({ ...base, phase: 'done', hasCleanupError: true }, t)
  assert.deepEqual([done.status, done.phase], ['临时文件未清理', 'partial'])
  const restore = restoreTaskPreview('failed', true, t)
  assert.deepEqual([restore.status, restore.phase], ['恢复失败 · 临时文件未清理', 'failed'])
})

test('任务条：等待对方设备开始时不写正在打包', () => {
  const t = createTranslator('zh-CN')
  const running = { phase: 'running', stage: 'preparing', step: 0, percent: null }
  const preview = (isAwaitingPeer) =>
    syncTaskPreview({ ...running, hasCleanupError: false, isAwaitingPeer }, t).status
  assert.equal(preview(true), '等待对方设备开始')
  assert.equal(preview(false), '正在打包')
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

test('四种语言的文案：文件夹单独计数，变化不限来源，待确认不再指向详情', () => {
  const sourceWords = { 'zh-CN': '来源', 'zh-TW': '來源', 'en-US': 'Source', 'ja-JP': '転送元' }
  const detailWords = { 'zh-CN': '详情', 'zh-TW': '詳情', 'en-US': 'details', 'ja-JP': '詳細' }
  for (const locale of LOCALES) {
    const t = createTranslator(locale)
    assert.ok(t('task.folderCount', { count: 2 }).includes('2'), locale)
    assert.ok(t('task.foldersCreatedDetail', { count: 2 }).includes('2'), locale)
    assert.ok(t('task.awaitingPeer').length > 0, locale)
    assert.ok(!t('error.code.source-changed').includes(sourceWords[locale]), locale)
    assert.ok(!t('error.code.result-unknown').includes(detailWords[locale]), locale)
    assert.notEqual(t('task.stage.cleaning'), t('task.cleanupFailed'), locale)
  }
})
