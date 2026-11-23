import assert from 'node:assert/strict'
import test from 'node:test'
import { BATCH_LIMITS, isBatchDeviceDescriptor, isBatchLimits } from '../src/index.ts'

test('HTTP 描述包装本地设备，预算不接受协商放宽或额外字段', () => {
  const descriptor = {
    device: {
      protocolVersion: 4,
      deviceId: 'device-1',
      displayName: '电脑',
      platform: 'windows',
      capabilities: {
        canListRoots: 'supported',
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
