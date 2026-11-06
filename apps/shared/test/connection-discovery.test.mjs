import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createConnectionCandidates,
  createConnectionQrText,
  createDiscoveryInstanceName,
  createDiscoveryTxt,
  parseConnectionQrText,
  parseDiscoveryTxt,
} from '../src/index.ts'

const PAYLOAD = { deviceId: 'pc-1', port: 47321, addresses: ['192.168.1.20', '10.0.0.5'] }
const QR_TEXT = 'savedata-sync://connect?v=1&id=pc-1&p=47321&a=192.168.1.20,10.0.0.5'

test('连接二维码生成后能解析回同样的内容', () => {
  assert.equal(createConnectionQrText(PAYLOAD), QR_TEXT)
  assert.deepEqual(parseConnectionQrText(QR_TEXT), { status: 'valid', payload: PAYLOAD })
})

test('连接二维码拒绝不合法的内容', () => {
  const invalid = [
    null,
    'https://example.com/?v=1&id=pc-1&p=47321&a=192.168.1.20',
    'SAVEDATA-SYNC://connect?v=1&id=pc-1&p=47321&a=192.168.1.20',
    'savedata-sync://connect?v=1&id=pc-1&p=47321',
    'savedata-sync://connect?v=1&id=pc-1&p=47321&a=192.168.1.20&x=1',
    'savedata-sync://connect?v=1&id=pc-1&id=pc-2&p=47321&a=192.168.1.20',
    'savedata-sync://connect?v=1&id=../pc&p=47321&a=192.168.1.20',
    'savedata-sync://connect?v=1&id=pc-1&p=65536&a=192.168.1.20',
    'savedata-sync://connect?v=1&id=pc-1&p=080&a=192.168.1.20',
    'savedata-sync://connect?v=1&id=pc-1&p=47321&a=192.168.001.20',
    'savedata-sync://connect?v=1&id=pc-1&p=47321&a=fe80::1',
    'savedata-sync://connect?v=1&id=pc-1&p=47321&a=192.168.1.20,192.168.1.20',
    `savedata-sync://connect?v=1&id=pc-1&p=47321&a=${Array.from({ length: 9 }, (_, i) => `10.0.0.${i + 1}`).join(',')}`,
    'savedata-sync://connect?v=one&id=pc-1&p=47321&a=192.168.1.20',
  ]
  for (const text of invalid) {
    assert.deepEqual(parseConnectionQrText(text), { status: 'invalid' }, String(text))
  }
  assert.throws(() => createConnectionQrText({ ...PAYLOAD, addresses: [] }), {
    code: 'invalid-request',
  })
})

test('协议版本不同的二维码单独报告', () => {
  assert.deepEqual(parseConnectionQrText('savedata-sync://connect?v=2&format=next'), {
    status: 'unsupported-version',
  })
})

test('候选地址保留顺序并跳过 IPv6 与重复地址', () => {
  assert.deepEqual(
    createConnectionCandidates(['192.168.1.20', 'fe80::1', '192.168.1.20', '10.0.0.5'], 47321),
    ['http://192.168.1.20:47321', 'http://10.0.0.5:47321'],
  )
  assert.throws(() => createConnectionCandidates(['192.168.1.20'], 0), { code: 'invalid-request' })
})

test('TXT 记录生成后能解析出设备身份，并忽略未知字段和键名大小写', () => {
  const txt = createDiscoveryTxt({ deviceId: 'phone-1', platform: 'android' })
  assert.deepEqual(txt, { v: '1', id: 'phone-1', pf: 'android' })
  assert.deepEqual(parseDiscoveryTxt({ V: '1', Id: 'phone-1', pf: 'android', extra: 'x' }), {
    status: 'valid',
    identity: { deviceId: 'phone-1', platform: 'android' },
  })
})

test('TXT 记录缺少字段、字段不合法或重复时拒绝，版本不同时单独报告', () => {
  const invalid = [
    null,
    { id: 'pc-1', pf: 'windows' },
    { v: '1', pf: 'windows' },
    { v: '1', id: 'pc 1', pf: 'windows' },
    { v: '1', id: 'pc-1', pf: 'linux' },
    { v: '1', id: 'pc-1', ID: 'pc-2', pf: 'windows' },
  ]
  for (const record of invalid) {
    assert.deepEqual(parseDiscoveryTxt(record), { status: 'invalid' }, JSON.stringify(record))
  }
  assert.deepEqual(parseDiscoveryTxt({ v: '2' }), { status: 'unsupported-version' })
})

test('实例名按码位截到 63 个 UTF-8 字节', () => {
  assert.equal(createDiscoveryInstanceName('  我的电脑  '), '我的电脑')
  const name = createDiscoveryInstanceName('存'.repeat(30))
  assert.equal(name, '存'.repeat(21))
})
