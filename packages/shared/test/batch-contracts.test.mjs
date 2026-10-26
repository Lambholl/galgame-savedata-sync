import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BATCH_LIMITS,
  BATCH_RESOURCES,
  BATCH_TIMEOUTS_MS,
  HTTP_ERROR_STATUS,
  HTTP_HEADERS,
  HTTP_ROUTES,
  isArchiveDescriptor,
  isBatchDeviceDescriptor,
  isBatchFileId,
  isBatchLimits,
  isBatchManifest,
  isBatchProgress,
  isBatchProgressAdvance,
  isBatchState,
  isDownloadBatchRequest,
  isFileOutcome,
  isOperationError,
  isPreparedFile,
  isReceiveBatchRequest,
} from '../src/index.ts'
import {
  createManifest,
  createReceiveRequest,
  createReceiverRunning,
  createReceiverState,
  createSenderState,
} from './batch-fixtures.mjs'

const FAILURE = { code: 'io-failure', message: '测试写入失败', canRetry: false }
const UNKNOWN = { code: 'result-unknown', message: '请核实目标', canRetry: false }

test('HTTP 描述包装本地设备，预算不接受协商放宽或额外字段', () => {
  const descriptor = {
    device: {
      protocolVersion: 1,
      deviceId: 'device-1',
      displayName: '电脑',
      platform: 'windows',
      capabilities: {
        canListRoots: 'supported',
        canReadFiles: 'supported',
        canReceiveFiles: 'unsupported',
        canQueryTransfers: 'supported',
        canCancelTransfers: 'supported',
      },
    },
    sessionId: 'session-1',
    limits: BATCH_LIMITS,
  }
  assert.equal(isBatchDeviceDescriptor(JSON.parse(JSON.stringify(descriptor))), true)
  assert.equal(isBatchDeviceDescriptor(descriptor.device), false)
  assert.equal(
    isBatchDeviceDescriptor({
      ...descriptor,
      device: { ...descriptor.device, protocolVersion: 2 },
    }),
    false,
  )
  assert.equal(isBatchDeviceDescriptor({ ...descriptor, sessionId: 'content://tree' }), false)
  for (const key of Object.keys(BATCH_LIMITS)) {
    assert.equal(isBatchLimits({ ...BATCH_LIMITS, [key]: BATCH_LIMITS[key] + 1 }), false, key)
  }
  assert.equal(isBatchLimits({ ...BATCH_LIMITS, unlimited: true }), false)
})

test('批内编号是有界连续 ID，不能携带路径、尾随换行或数字强制转换', () => {
  for (const value of ['f000001', 'f001024']) assert.equal(isBatchFileId(value), true)
  for (const value of [
    'f000000',
    'f001025',
    'f1',
    'f000001\n',
    '../f000001',
    'f０００００１',
    ['f000001'],
    null,
  ])
    assert.equal(isBatchFileId(value), false)
  const request = {
    protocolVersion: 1,
    transferId: 'batch-1',
    sourceRootId: 'root-source',
    files: [
      { fileId: 'f000001', entryId: 'source-1' },
      { fileId: 'f000002', entryId: 'source-2' },
    ],
  }
  assert.equal(isDownloadBatchRequest(request), true)
  for (const files of [
    [],
    new Array(1),
    request.files.toReversed(),
    [request.files[0], { ...request.files[1], entryId: 'source-1' }],
    [request.files[0], { ...request.files[1], fileId: 'f000001' }],
  ])
    assert.equal(isDownloadBatchRequest({ ...request, files }), false)
  assert.equal(isDownloadBatchRequest({ ...request, protocolVersion: '1' }), false)
})

test('已准备清单实测未知长度，严格验证求和及 tar 填充长度', () => {
  const manifest = createManifest([0, 1, 512, 513])
  assert.equal(manifest.archive.tarSizeBytes, 5120)
  assert.equal(isBatchManifest(manifest), true)
  assert.equal(isBatchManifest({ ...manifest, totalFileBytes: manifest.totalFileBytes + 1 }), false)
  assert.equal(
    isBatchManifest({ ...manifest, archive: { ...manifest.archive, tarSizeBytes: 5120 + 512 } }),
    false,
  )
  assert.equal(isBatchManifest({ ...manifest, files: manifest.files.toReversed() }), false)
  assert.equal(isBatchManifest({ ...manifest, absolutePath: 'C:/private' }), false)
  const file = manifest.files[0]
  for (const sizeBytes of [
    null,
    undefined,
    '0',
    -1,
    0.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.equal(isPreparedFile({ ...file, sizeBytes }), false)
  assert.equal(isPreparedFile({ ...file, sourceModifiedAt: -1 }), true)
  assert.equal(isPreparedFile({ ...file, sourceModifiedAt: 8.64e15 + 1 }), false)
  assert.equal(isPreparedFile({ ...file, sourceName: '\uD800' }), false)
  assert.equal(isPreparedFile({ ...file, sourceParentId: file.sourceEntryId }), false)
  assert.equal(
    isBatchManifest({
      ...manifest,
      files: manifest.files.map((item) => ({ ...item, sourceEntryId: 'same-source' })),
    }),
    false,
  )
})

test('不分配真实大文件也可检查成员、原文、压缩体及 tar 的精确预算边界', () => {
  assert.equal(isBatchManifest(createManifest([BATCH_LIMITS.maxFileBytes])), true)
  assert.equal(isBatchManifest(createManifest([BATCH_LIMITS.maxFileBytes + 1])), false)
  assert.equal(isBatchManifest(createManifest(Array(4).fill(BATCH_LIMITS.maxFileBytes))), true)
  assert.equal(
    isBatchManifest(createManifest([...Array(4).fill(BATCH_LIMITS.maxFileBytes), 1])),
    false,
  )
  assert.equal(isBatchManifest(createManifest(Array(BATCH_LIMITS.maxFiles).fill(0))), true)
  assert.equal(isBatchManifest(createManifest(Array(BATCH_LIMITS.maxFiles + 1).fill(0))), false)
  const sizes = Array(1024).fill(1048577)
  sizes[1023] -= 1024
  const exact = createManifest(sizes)
  assert.equal(exact.totalFileBytes, BATCH_LIMITS.maxTotalFileBytes)
  assert.equal(exact.archive.tarSizeBytes, BATCH_LIMITS.maxTarBytes)
  assert.equal(isBatchManifest(exact), true)
  assert.equal(
    isArchiveDescriptor({ ...exact.archive, sizeBytes: BATCH_LIMITS.maxArchiveBytes }),
    true,
  )
  for (const archive of [
    { ...exact.archive, sizeBytes: BATCH_LIMITS.maxArchiveBytes + 1 },
    { ...exact.archive, sizeBytes: 0 },
    { ...exact.archive, tarSizeBytes: BATCH_LIMITS.maxTarBytes + 512 },
    { ...exact.archive, compressionLevel: 9 },
    { ...exact.archive, format: 'tar' },
  ])
    assert.equal(isArchiveDescriptor(archive), false)
})

test('目标可以乱序映射，但必须一一对应且不映射到同一个显式位置', () => {
  const request = createReceiveRequest([0, 513])
  assert.equal(isReceiveBatchRequest(request), true)
  assert.equal(isReceiveBatchRequest({ ...request, targets: request.targets.toReversed() }), true)
  for (const targets of [
    [],
    [request.targets[0]],
    [request.targets[0], request.targets[0]],
    [{ ...request.targets[0], fileId: 'f000003' }, request.targets[1]],
    [{ ...request.targets[0], name: '../outside' }, request.targets[1]],
    [{ ...request.targets[0], name: 'CON.dat' }, request.targets[1]],
    [request.targets[0], { ...request.targets[1], name: request.targets[0].name }],
  ])
    assert.equal(isReceiveBatchRequest({ ...request, targets }), false)
  assert.equal(
    isReceiveBatchRequest({
      ...request,
      targets: [
        request.targets[0],
        { ...request.targets[1], parentId: 'subdir', name: request.targets[0].name },
      ],
    }),
    true,
  )
  assert.equal(isReceiveBatchRequest({ ...request, overwrite: true }), false)
})

test('文件结果区分失败、取消、未尝试和待确认，成功必须包含实际文件元数据', () => {
  const result = createReceiverState().fileResults[0]
  assert.equal(isFileOutcome(result), true)
  assert.equal(
    isFileOutcome({ ...result, entry: { ...result.entry, kind: 'directory', sizeBytes: null } }),
    false,
  )
  assert.equal(isFileOutcome({ ...result, bytesWritten: 1 }), false)
  assert.equal(isFileOutcome({ ...result, error: FAILURE }), false)
  for (const outcome of [
    { fileId: 'f000001', status: 'failed', error: FAILURE, residualEntries: [] },
    { fileId: 'f000001', status: 'cancelled', residualEntries: [] },
    { fileId: 'f000001', status: 'not-attempted', reason: 'batch-invalid' },
    { fileId: 'f000001', status: 'unknown', error: UNKNOWN, residualEntries: [] },
  ])
    assert.equal(isFileOutcome(outcome), true)
  assert.equal(
    isFileOutcome({ fileId: 'f000001', status: 'failed', error: UNKNOWN, residualEntries: [] }),
    false,
  )
  assert.equal(
    isFileOutcome({ fileId: 'f000001', status: 'unknown', error: FAILURE, residualEntries: [] }),
    false,
  )
  const residual = { rootId: 'root-target', entryId: 'partial' }
  assert.equal(
    isFileOutcome({
      fileId: 'f000001',
      status: 'cancelled',
      residualEntries: [residual, residual],
    }),
    false,
  )
})

test('未知总量与零字节不同，进度不能溢出、超总量或以字节代替文件数', () => {
  const progress = createSenderState().progress
  assert.equal(isBatchProgress(progress), true)
  assert.equal(
    isBatchProgress({ ...progress, totalFileBytes: null, totalArchiveBytes: null }),
    true,
  )
  for (const value of [-1, 0.5, NaN, Infinity, '0', Number.MAX_SAFE_INTEGER + 1])
    assert.equal(isBatchProgress({ ...progress, archiveBytesTransferred: value }), false)
  for (const changes of [
    { sourceBytesRead: 1 },
    { totalFiles: 0 },
    { verifiedFiles: 2 },
    { publishedFiles: 1 },
    { archiveBytesTransferred: 101 },
    { totalArchiveBytes: 0 },
    { fileBytesPublished: 1 },
  ])
    assert.equal(isBatchProgress({ ...progress, ...changes }), false)
})

test('进度快照只能推进计数，不能回退或更改已经确定的总量', () => {
  const progress = createSenderState(createManifest([10])).progress
  const before = { ...progress, sourceBytesRead: 0, totalFileBytes: null, totalArchiveBytes: null }
  assert.equal(isBatchProgressAdvance(before, progress), true)
  assert.equal(isBatchProgressAdvance(progress, before), false)
  assert.equal(isBatchProgressAdvance(progress, { ...progress, totalFileBytes: 11 }), false)
  assert.equal(isBatchProgressAdvance(progress, { ...progress, totalFiles: 2 }), false)
  assert.equal(isBatchProgressAdvance(progress, { ...progress, sourceBytesRead: 9 }), false)
  assert.equal(isBatchProgress({ ...progress, verifiedFiles: 1, fileBytesVerified: 9 }), false)
  assert.equal(
    isBatchProgress({
      ...progress,
      verifiedFiles: 1,
      fileBytesVerified: 10,
      publishedFiles: 1,
      fileBytesPublished: 9,
    }),
    false,
  )
})

test('sender 只能准备和发送，不能伪装为 receiver 的目标发布成功', () => {
  const running = createSenderState()
  assert.equal(isBatchState(running), true)
  const end = {
    transferId: running.transferId,
    direction: running.direction,
    role: 'sender',
    updatedAt: 0,
    status: 'sent',
    error: null,
    fileResults: null,
    cleanupStatus: 'complete',
    cleanupError: null,
  }
  assert.equal(isBatchState(end), true)
  assert.equal(isBatchState({ ...end, status: 'succeeded' }), false)
  assert.equal(isBatchState({ ...running, stage: 'publishing' }), false)
  assert.equal(
    isBatchState({ ...running, progress: { ...running.progress, verifiedFiles: 1 } }),
    false,
  )
  assert.equal(
    isBatchState({
      ...running,
      stage: 'ready',
      progress: { ...running.progress, totalArchiveBytes: null },
    }),
    false,
  )
  assert.equal(isBatchState({ ...end, progress: running.progress }), false)
})

test('receiver 发布阶段必须先收齐归档并校验全部原文，已发布计数对应真实结果', () => {
  const request = createReceiveRequest([10, 0])
  const running = createReceiverRunning(request)
  assert.equal(isBatchState(running), true)
  assert.equal(
    isBatchState({ ...running, progress: { ...running.progress, archiveBytesTransferred: 99 } }),
    false,
  )
  assert.equal(
    isBatchState({ ...running, progress: { ...running.progress, verifiedFiles: 1 } }),
    false,
  )
  assert.equal(
    isBatchState({ ...running, progress: { ...running.progress, fileBytesVerified: 9 } }),
    false,
  )
  const success = createReceiverState(request).fileResults[0]
  const firstPublished = {
    ...running,
    fileResults: [success],
    progress: { ...running.progress, publishedFiles: 1, fileBytesPublished: 10 },
  }
  assert.equal(isBatchState(firstPublished), true)
  assert.equal(isBatchState({ ...firstPublished, stage: 'transferring' }), false)
  assert.equal(
    isBatchState({
      ...firstPublished,
      progress: { ...firstPublished.progress, fileBytesPublished: 9 },
    }),
    false,
  )
})

test('批次部分失败保留前项成功，后项未尝试，不能报整批成功或继续发布', () => {
  const request = createReceiveRequest([1, 2, 3])
  const end = createReceiverState(request)
  const results = [
    end.fileResults[0],
    { fileId: 'f000002', status: 'failed', error: FAILURE, residualEntries: [] },
    { fileId: 'f000003', status: 'not-attempted', reason: 'prior-failure' },
  ]
  const partial = { ...end, status: 'failed', error: FAILURE, fileResults: results }
  assert.equal(isBatchState(partial), true)
  assert.equal(isBatchState({ ...partial, status: 'succeeded', error: null }), false)
  assert.equal(
    isBatchState({ ...partial, fileResults: [...results.slice(0, 2), end.fileResults[2]] }),
    false,
  )
  assert.equal(
    isBatchState({
      ...partial,
      fileResults: [results[0], { ...results[1], fileId: 'f000001' }, results[2]],
    }),
    false,
  )
  assert.equal(isBatchState({ ...end, status: 'failed', error: FAILURE }), false)
})

test('取消与未知有独立实际结果，整批校验失败只标记未尝试', () => {
  const end = createReceiverState(createReceiveRequest([0, 0]))
  const cancelled = {
    ...end,
    status: 'cancelled',
    fileResults: [
      { fileId: 'f000001', status: 'cancelled', residualEntries: [] },
      { fileId: 'f000002', status: 'not-attempted', reason: 'cancelled' },
    ],
  }
  assert.equal(isBatchState(cancelled), true)
  assert.equal(isBatchState({ ...cancelled, status: 'failed', error: FAILURE }), false)
  const unknown = {
    ...cancelled,
    status: 'unknown',
    error: UNKNOWN,
    fileResults: [
      { fileId: 'f000001', status: 'unknown', error: UNKNOWN, residualEntries: [] },
      { fileId: 'f000002', status: 'not-attempted', reason: 'prior-failure' },
    ],
  }
  assert.equal(isBatchState(unknown), true)
  assert.equal(isBatchState({ ...unknown, error: FAILURE }), false)
  const invalid = {
    ...end,
    status: 'failed',
    error: { ...FAILURE, code: 'invalid-archive' },
    fileResults: end.fileResults.map((file) => ({
      fileId: file.fileId,
      status: 'not-attempted',
      reason: 'batch-invalid',
    })),
  }
  assert.equal(isBatchState(invalid), true)
})

test('私有缓存清理失败不能掩盖已成功发布，清理错误须与清理状态对应', () => {
  const end = createReceiverState()
  assert.equal(
    isBatchState({
      ...end,
      cleanupStatus: 'incomplete',
      cleanupError: { ...FAILURE, code: 'cleanup-failed' },
    }),
    true,
  )
  assert.equal(isBatchState({ ...end, cleanupStatus: 'incomplete', cleanupError: null }), false)
  assert.equal(isBatchState({ ...end, cleanupStatus: 'complete', cleanupError: FAILURE }), false)
  assert.equal(isBatchState({ ...end, cleanupStatus: 'unknown', cleanupError: UNKNOWN }), true)
})

test('封闭枚举和 JSON 容器不接受数组、对象、类实例或字符串强制转换', () => {
  const end = createReceiverState()
  for (const value of [
    null,
    undefined,
    [],
    new Date(),
    Object.create(end),
    { ...end, extra: true },
  ])
    assert.equal(isBatchState(value), false)
  for (const status of [['succeeded'], { value: 'succeeded' }, 1])
    assert.equal(isBatchState({ ...end, status }), false)
  assert.equal(
    isFileOutcome({ fileId: 'f000001', status: 'not-attempted', reason: ['batch-invalid'] }),
    false,
  )
  assert.equal(isBatchState({ ...createSenderState(), stage: ['ready'] }), false)
  const roundTrip = JSON.parse(JSON.stringify(end))
  const before = structuredClone(roundTrip)
  assert.equal(isBatchState(roundTrip), true)
  assert.deepEqual(roundTrip, before)
})

test('v1 批量路由、头和新增错误映射一致，旧会话与未知结果不允许直接重放', () => {
  assert.equal(HTTP_ROUTES.content, '/v1/transfers/{transferId}/content')
  assert.equal(HTTP_ROUTES.uploads, '/v1/transfers/uploads')
  assert.equal(HTTP_HEADERS.sessionId, 'x-sync-session-id')
  assert.equal(HTTP_HEADERS.archiveSha256, 'x-archive-sha256')
  for (const [code, status] of [
    ['session-mismatch', 409],
    ['task-conflict', 409],
    ['invalid-archive', 422],
    ['resource-limit', 413],
    ['busy', 429],
    ['timeout', 408],
  ]) {
    assert.equal(HTTP_ERROR_STATUS[code], status)
    assert.equal(isOperationError({ code, message: '测试错误', canRetry: false }), true)
  }
  for (const code of ['session-mismatch', 'result-unknown'])
    assert.equal(isOperationError({ code, message: '禁止重放', canRetry: true }), false)
  assert.equal(
    BATCH_RESOURCES.maxCacheBytes >= BATCH_LIMITS.maxArchiveBytes + BATCH_LIMITS.maxTotalFileBytes,
    true,
  )
  assert.equal(BATCH_TIMEOUTS_MS.awaitingContent < BATCH_TIMEOUTS_MS.total, true)
})
