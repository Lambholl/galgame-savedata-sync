import assert from 'node:assert/strict'
import test from 'node:test'
import {
  HTTP_ERROR_STATUS,
  PROTOCOL_VERSION,
  isDeviceDescriptor,
  isDirectoryListing,
  isDirectorySelectionResult,
  isEntryMetadata,
  isOperationError,
  isOperationResult,
  isPortableFileName,
  isProtocolVersionSupported,
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

test('错误拒绝未知码，网络失败不伪造 HTTP 响应，任务未知不授权重放', () => {
  assert.equal(isOperationError(ERROR), true)
  assert.equal(isOperationError({ ...ERROR, code: 'invented-error' }), false)
  assert.equal(isOperationError({ ...ERROR, code: 'toString' }), false)
  assert.equal(HTTP_ERROR_STATUS['network-failure'], null)
  assert.equal(HTTP_ERROR_STATUS['result-unknown'], 404)
  assert.equal(HTTP_ERROR_STATUS['checksum-mismatch'], 422)
})
