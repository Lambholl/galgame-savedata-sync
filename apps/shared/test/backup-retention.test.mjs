import assert from 'node:assert/strict'
import test from 'node:test'
import { isSyncBackupManifest, readSyncBackupManifest } from '../src/index.ts'

test('备份清单接受 copy、restore 和 manual 原因并拒绝未知原因', () => {
  const base = {
    schemaVersion: 1,
    backupId: 'backup-1',
    projectId: 'game-1',
    deviceId: 'device-1',
    rootId: 'root-1',
    createdAt: 1700000000000,
    files: [{ fileId: 'f000001', path: ['save.dat'], sizeBytes: 12, modifiedAt: 1700000000000 }],
  }
  for (const reason of ['copy', 'restore', 'manual']) {
    assert.equal(isSyncBackupManifest({ ...base, reason }), true)
    assert.ok(readSyncBackupManifest({ ...base, reason }))
  }
  assert.equal(isSyncBackupManifest({ ...base, reason: 'auto' }), false)
})
