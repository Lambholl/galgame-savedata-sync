import assert from 'node:assert/strict'
import test from 'node:test'
import { isBatchState, matchesBatchState } from '../src/index.ts'
import {
  createManifest,
  createReceiveRequest,
  createReceiverRunning,
  createReceiverState,
  createSenderState,
} from './batch-fixtures.mjs'

const DIRECTION = 'android-to-windows'

test('结构合法的成功结果仍须匹配原清单和目标，不能借同一 ID 冒充另一任务', () => {
  const request = createReceiveRequest([0, 513])
  const end = createReceiverState(request)
  assert.equal(matchesBatchState(end, request.manifest, DIRECTION, request), true)
  assert.equal(matchesBatchState(end, request.manifest, DIRECTION), false)
  assert.equal(matchesBatchState(end, request.manifest, 'windows-to-android', request), false)
  assert.equal(
    matchesBatchState({ ...end, transferId: 'other' }, request.manifest, DIRECTION, request),
    false,
  )
  assert.equal(
    matchesBatchState(
      { ...end, fileResults: [end.fileResults[0]] },
      request.manifest,
      DIRECTION,
      request,
    ),
    false,
  )
  const other = { ...request, manifest: { ...request.manifest, sourceRootId: 'other-source' } }
  assert.equal(matchesBatchState(end, request.manifest, DIRECTION, other), false)
})

test('不同成功项不能指向同一最终条目，失败残留不能别名成功条目或跨根', () => {
  const request = createReceiveRequest([0, 0])
  const end = createReceiverState(request)
  assert.equal(
    matchesBatchState(
      {
        ...end,
        fileResults: [
          end.fileResults[0],
          { ...end.fileResults[1], entry: { ...end.fileResults[1].entry, entryId: 'target-1' } },
        ],
      },
      request.manifest,
      DIRECTION,
      request,
    ),
    false,
  )
  for (const residual of [
    { rootId: 'other-root', entryId: 'partial' },
    { rootId: 'root-target', entryId: 'target-1' },
  ]) {
    const error = { code: 'io-failure', message: '测试失败', canRetry: false }
    const partial = {
      ...end,
      status: 'failed',
      error,
      fileResults: [
        end.fileResults[0],
        { fileId: 'f000002', status: 'failed', error, residualEntries: [residual] },
      ],
    }
    assert.equal(isBatchState(partial), true)
    assert.equal(matchesBatchState(partial, request.manifest, DIRECTION, request), false)
  }
})

test('运行计数须属于本次清单，sender 不接受目标上下文，未准备总量可未知', () => {
  const manifest = createManifest([10])
  const sender = createSenderState(manifest)
  assert.equal(matchesBatchState(sender, manifest, 'windows-to-android'), true)
  assert.equal(
    matchesBatchState(sender, manifest, 'windows-to-android', createReceiveRequest()),
    false,
  )
  assert.equal(
    matchesBatchState(
      { ...sender, progress: { ...sender.progress, totalFiles: 2 } },
      manifest,
      'windows-to-android',
    ),
    false,
  )
  assert.equal(
    matchesBatchState(
      {
        ...sender,
        stage: 'preparing',
        progress: {
          ...sender.progress,
          sourceBytesRead: 0,
          totalFileBytes: null,
          totalArchiveBytes: null,
        },
      },
      manifest,
      'windows-to-android',
    ),
    true,
  )
  const request = createReceiveRequest([10])
  const receiver = createReceiverRunning(request)
  assert.equal(matchesBatchState(receiver, request.manifest, DIRECTION, request), true)
  const larger = {
    ...receiver,
    progress: { ...receiver.progress, totalFileBytes: 11, fileBytesVerified: 11 },
  }
  assert.equal(isBatchState(larger), true)
  assert.equal(matchesBatchState(larger, request.manifest, DIRECTION, request), false)
})
