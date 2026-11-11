import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { isWriteCandidateName, writeCandidateName } from '../src/index.ts'

test('写入候选文件名能被识别，相近的名称不算候选文件', () => {
  const id = randomUUID()
  assert.equal(writeCandidateName('copy', id), `.savedata-copy-${id}.tmp`)
  assert.equal(isWriteCandidateName(writeCandidateName('copy', id)), true)
  assert.equal(isWriteCandidateName(writeCandidateName('new', id)), true)
  for (const name of [
    `.savedata-copy-${id.toUpperCase()}.tmp`,
    `.savedata-other-${id}.tmp`,
    `save.savedata-copy-${id}.tmp`,
    `.savedata-copy-${id}.tmp.bak`,
    '.savedata-copy-.tmp',
  ]) {
    assert.equal(isWriteCandidateName(name), false, name)
  }
  assert.throws(() => writeCandidateName('copy', id.toUpperCase()), TypeError)
})
