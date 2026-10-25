import assert from 'node:assert/strict'
import test from 'node:test'
import {
  HTTP_ERROR_STATUS,
  PROTOCOL_VERSION,
  isCreateFileRequest,
  isDeviceDescriptor,
  isDirectoryListing,
  isDirectoryReference,
  isDirectorySelectionResult,
  isEntryMetadata,
  isOperationError,
  isOperationResult,
  isOpaqueId,
  isPortableFileName,
  isProtocolVersionSupported,
  isSha256,
  isTransferProgress,
  isTransferResult,
  isTransferState,
} from '../src/index.ts'

const CAPABILITIES = {
  canRead: 'supported',
  canList: 'unsupported',
  canCreate: 'unknown',
  canRename: 'unknown',
  canDelete: 'unsupported',
}
const FILE = {
  rootId: 'root-1',
  entryId: 'entry-1',
  parentId: null,
  name: '存档 01.dat',
  kind: 'file',
  sizeBytes: 0,
  modifiedAt: null,
  capabilities: CAPABILITIES,
}
const DIRECTORY = { ...FILE, kind: 'directory', sizeBytes: null }
const LISTING = { rootId: 'root-1', parentId: null, observedAt: 1000, entries: [] }
const ROOT = {
  rootId: 'root-1',
  deviceId: 'device-1',
  displayName: '测试目录',
  authorization: 'granted',
}
const ERROR = { code: 'authorization-expired', message: '请重新选择目录', canRetry: false }
const IDENTITY = { transferId: 'transfer-1', direction: 'android-to-windows' }
const PROGRESS = {
  ...IDENTITY,
  status: 'running',
  stage: 'transferring',
  bytesTransferred: 0,
  totalBytes: null,
}
const SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const RECEIPT = {
  ...IDENTITY,
  status: 'succeeded',
  bytesTransferred: 0,
  sha256: SHA256,
  entry: FILE,
}
const UNKNOWN = {
  ...IDENTITY,
  status: 'unknown',
  error: { code: 'result-unknown', message: '重新读取目标核实结果', canRetry: false },
}

test('协议只接受确切版本，缺失、未来版本和类型强制转换均被拒绝', () => {
  const device = {
    protocolVersion: PROTOCOL_VERSION,
    deviceId: 'device-1',
    displayName: '测试电脑',
    platform: 'windows',
    capabilities: {
      canListRoots: 'supported',
      canReadFiles: 'supported',
      canReceiveFiles: 'supported',
      canQueryTransfers: 'supported',
      canCancelTransfers: 'supported',
    },
  }
  assert.equal(isDeviceDescriptor(JSON.parse(JSON.stringify(device))), true)
  for (const protocolVersion of [undefined, null, '1', 0, 2, 1.1, Infinity]) {
    assert.equal(isProtocolVersionSupported(protocolVersion), false)
    assert.equal(isDeviceDescriptor({ ...device, protocolVersion }), false)
  }
  assert.equal(
    isDeviceDescriptor({ ...device, capabilities: { ...device.capabilities, canReadFiles: true } }),
    false,
  )
})

test('公开根引用不包含平台路径，待核实授权不冒充有效授权', () => {
  for (const authorization of ['granted', 'expired', 'unavailable', 'unverified']) {
    assert.equal(isDirectoryReference({ ...ROOT, authorization }), true)
  }
  assert.equal(isDirectoryReference({ ...ROOT, path: 'C:/secret' }), false)
  assert.equal(isDirectoryReference({ ...ROOT, contentUri: 'content://provider/tree' }), false)
  assert.equal(isDirectoryReference({ ...ROOT, authorization: true }), false)
})

test('空目录、授权失败和选择取消在 JSON 往返后保持不同结果', () => {
  const empty = { status: 'success', value: LISTING }
  const failure = { status: 'error', error: ERROR }
  for (const value of [empty, failure]) {
    assert.equal(isOperationResult(JSON.parse(JSON.stringify(value)), isDirectoryListing), true)
  }
  assert.equal(isOperationResult({ ...empty, error: ERROR }, isDirectoryListing), false)
  assert.equal(isOperationResult({ status: 'success', value: null }, isDirectoryListing), false)
  assert.equal(isDirectorySelectionResult({ status: 'cancelled' }), true)
  assert.equal(isDirectorySelectionResult({ status: 'selected', directory: ROOT }), true)
  assert.equal(isDirectorySelectionResult({ status: 'error', error: ERROR }), true)
  assert.equal(isDirectorySelectionResult({ status: 'cancelled', directory: ROOT }), false)
})

test('未知文件大小不等于空文件，目录不允许携带汇总大小', () => {
  assert.equal(isEntryMetadata(FILE), true)
  assert.equal(isEntryMetadata({ ...FILE, sizeBytes: null, modifiedAt: 0 }), true)
  assert.equal(isEntryMetadata({ ...FILE, modifiedAt: -1 }), true)
  assert.equal(isEntryMetadata(DIRECTORY), true)
  assert.equal(isEntryMetadata({ ...DIRECTORY, sizeBytes: 0 }), false)
  assert.equal(isEntryMetadata({ ...DIRECTORY, sizeBytes: 12345 }), false)
  assert.equal(isEntryMetadata({ ...FILE, sizeBytes: undefined }), false)
  assert.equal(isEntryMetadata({ ...FILE, sizeBytes: '0' }), false)
})

test('字节和时间拒绝溢出、非整数和非 JSON 数值', () => {
  for (const sizeBytes of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(isEntryMetadata({ ...FILE, sizeBytes }), false)
    assert.equal(isTransferProgress({ ...PROGRESS, bytesTransferred: sizeBytes }), false)
  }
  for (const modifiedAt of [0.5, NaN, Infinity, 8.64e15 + 1]) {
    assert.equal(isEntryMetadata({ ...FILE, modifiedAt }), false)
  }
  assert.equal(isEntryMetadata({ ...FILE, sizeBytes: Number.MAX_SAFE_INTEGER }), true)
})

test('当前层清单拒绝跨根、跨层、自引用、重复条目和稀疏列表', () => {
  assert.equal(isDirectoryListing({ ...LISTING, entries: [FILE] }), true)
  for (const entries of [
    [{ ...FILE, rootId: 'other-root' }],
    [{ ...FILE, parentId: 'parent-1' }],
    [{ ...FILE, parentId: FILE.entryId }],
    [FILE, FILE],
    [undefined],
    new Array(1),
  ]) {
    assert.equal(isDirectoryListing({ ...LISTING, entries }), false)
  }
})

test('未知能力与不支持不同，缺失能力和布尔强制转换均被拒绝', () => {
  for (const canRead of ['supported', 'unsupported', 'unknown']) {
    assert.equal(isEntryMetadata({ ...FILE, capabilities: { ...CAPABILITIES, canRead } }), true)
  }
  for (const canRead of [true, false, null, undefined, 'yes']) {
    assert.equal(isEntryMetadata({ ...FILE, capabilities: { ...CAPABILITIES, canRead } }), false)
  }
  assert.equal(isEntryMetadata({ ...FILE, capabilities: {} }), false)
})

test('不透明 ID 拒绝路径、转义、换行和越长输入', () => {
  for (const value of ['root-1', 'Entry_2', 'a'.repeat(128)]) assert.equal(isOpaqueId(value), true)
  for (const value of [
    '',
    '/root',
    '..',
    '../a',
    'a/b',
    'a\\b',
    'content://tree',
    '%2e%2e',
    'a\n',
    'a'.repeat(129),
  ]) {
    assert.equal(isOpaqueId(value), false, value)
  }
})

test('新文件名保留 Unicode，拒绝路径、Windows 保留名和歧义尾部', () => {
  for (const name of ['存档 01.dat', '😀.dat', 'a'.repeat(255), 'COM10.dat', 'e\u0301.dat']) {
    assert.equal(isPortableFileName(name), true, name)
  }
  for (const name of [
    '',
    '.',
    '..',
    '../save',
    'a/b',
    'a\\b',
    'save:stream',
    'NUL',
    'con.txt',
    'COM¹.dat',
    'LPT9',
    'CONOUT$',
    'save.',
    'save ',
    'a\n',
    'a\u0000b',
    '\uD800',
    'a'.repeat(256),
  ]) {
    assert.equal(isPortableFileName(name), false, name)
  }
  // 浏览元数据可以显示不可跨平台创建的名称，不能静默改名。
  assert.equal(isEntryMetadata({ ...FILE, name: 'CON.dat' }), true)
})

test('新建请求只携带本次校验数据，拒绝缺失字段和额外覆盖选项', () => {
  const request = {
    rootId: 'root-1',
    parentId: null,
    transferId: 'transfer-1',
    name: FILE.name,
    expectedSizeBytes: null,
    expectedSha256: SHA256,
  }
  assert.equal(isCreateFileRequest(request), true)
  assert.equal(isCreateFileRequest({ ...request, expectedSizeBytes: 0 }), true)
  assert.equal(isCreateFileRequest({ ...request, overwrite: true }), false)
  assert.equal(isCreateFileRequest({ ...request, name: '../outside' }), false)
  assert.equal(isCreateFileRequest({ ...request, expectedSha256: undefined }), false)
  for (const hash of [
    SHA256.toUpperCase(),
    SHA256 + '\n',
    SHA256.slice(1) + '\n',
    '',
    'g'.repeat(64),
  ]) {
    assert.equal(isSha256(hash), false)
    assert.equal(isCreateFileRequest({ ...request, expectedSha256: hash }), false)
  }
})

test('未知总量不伪造百分比，字节传满仍需校验和发布', () => {
  assert.equal(isTransferProgress(PROGRESS), true)
  for (const stage of ['preparing', 'transferring', 'verifying', 'publishing']) {
    const value = { ...PROGRESS, stage, bytesTransferred: 10, totalBytes: 10 }
    assert.equal(isTransferProgress(value), true)
    assert.equal(isTransferResult(value), false)
  }
  assert.equal(isTransferProgress({ ...PROGRESS, bytesTransferred: 11, totalBytes: 10 }), false)
  assert.equal(isTransferProgress({ ...PROGRESS, stage: 'succeeded' }), false)
})

test('成功回执必须有最终文件、实际字节及本次哈希，不能混入错误', () => {
  assert.equal(isTransferResult(RECEIPT), true)
  assert.equal(isTransferState(RECEIPT), true)
  for (const value of [
    { ...RECEIPT, error: ERROR },
    { ...RECEIPT, sha256: '' },
    { ...RECEIPT, entry: DIRECTORY },
    { ...RECEIPT, entry: { ...FILE, sizeBytes: 1 } },
    { ...RECEIPT, bytesTransferred: undefined },
  ])
    assert.equal(isTransferResult(value), false)
})

test('失败、取消和结果未知保持独立，清理残留可以明确报告', () => {
  const residualEntry = { rootId: 'root-1', entryId: 'partial-1' }
  assert.equal(
    isTransferResult({ ...IDENTITY, status: 'failed', error: ERROR, residualEntry }),
    true,
  )
  assert.equal(isTransferResult({ ...IDENTITY, status: 'cancelled', residualEntry: null }), true)
  assert.equal(isTransferResult(UNKNOWN), true)
  assert.equal(isTransferResult({ ...UNKNOWN, error: { ...UNKNOWN.error, canRetry: true } }), false)
  assert.equal(isTransferResult({ ...UNKNOWN, status: 'failed', residualEntry: null }), false)
  assert.equal(isTransferResult({ ...UNKNOWN, error: ERROR }), false)
  assert.equal(isTransferResult({ ...IDENTITY, status: 'cancelled' }), false)
})

test('错误拒绝未知码，网络失败不伪造 HTTP 响应，任务未知不授权重放', () => {
  assert.equal(isOperationError(ERROR), true)
  assert.equal(isOperationError({ ...ERROR, code: 'invented-error' }), false)
  assert.equal(isOperationError({ ...ERROR, code: 'toString' }), false)
  assert.equal(HTTP_ERROR_STATUS['network-failure'], null)
  assert.equal(HTTP_ERROR_STATUS['result-unknown'], 404)
  assert.equal(HTTP_ERROR_STATUS['checksum-mismatch'], 422)
})

test('守卫拒绝非 JSON 容器及额外字段，不改变合法输入', () => {
  for (const value of [null, undefined, [], new Date(), 0, 'text', Object.create({ ...LISTING })]) {
    assert.equal(isDirectoryListing(value), false)
    assert.equal(isTransferState(value), false)
  }
  assert.equal(isDirectoryListing({ ...LISTING, error: ERROR }), false)
  const value = structuredClone({ ...LISTING, entries: [FILE] })
  const before = structuredClone(value)
  assert.equal(isDirectoryListing(value), true)
  assert.deepEqual(value, before)
})
