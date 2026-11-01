import assert from 'node:assert/strict'
import test from 'node:test'
import { compareSnapshots, comparisonChildren, splitPathAtSeparators } from '../src/index.ts'

let next = 0
function entry(path, kind, sha256 = null, sizeBytes = 10) {
  return {
    entryId: String(next++),
    path: path.split('/'),
    kind,
    sizeBytes: kind === 'file' ? sizeBytes : null,
    modifiedAt: 1,
    sha256,
    error: null,
  }
}
function snapshot(entries) {
  return {
    schemaVersion: 1,
    scanId: 'scan',
    deviceId: 'device',
    rootId: 'root',
    observedAt: 1,
    entries,
    error: null,
  }
}

const pc = snapshot([
  entry('save', 'directory'),
  entry('save/a.sav', 'file', 'a'),
  entry('save/b.sav', 'file', 'b'),
  entry('shot 10.png', 'file', 'p'),
  entry('shot 2.png', 'file', 'q'),
  entry('same.ini', 'file', 's'),
])
const phone = snapshot([
  entry('save', 'directory'),
  entry('save/a.sav', 'file', 'a'),
  entry('save/b.sav', 'file', 'B'),
  entry('save/c.sav', 'file', 'c'),
  entry('same.ini', 'file', 's'),
  entry('unknown.dat', 'file', null),
])

test('counts differing and one-sided files', () => {
  const comparison = compareSnapshots(pc, phone)
  assert.equal(comparison.differingFiles, 1)
  assert.deepEqual(comparison.onlyFiles, { pc: 2, phone: 2 })
})

test('lists folders first in natural order with states', () => {
  const comparison = compareSnapshots(pc, phone)
  const root = comparisonChildren(comparison, 'pc', [])
  assert.deepEqual(
    root.map((item) => [item.name, item.kind, item.state]),
    [
      ['save', 'directory', 'contains-differences'],
      ['same.ini', 'file', 'same'],
      ['shot 2.png', 'image', 'only'],
      ['shot 10.png', 'image', 'only'],
    ],
  )
  assert.equal(root[0].differingCount, 2)
  const save = comparisonChildren(comparison, 'phone', ['save'])
  assert.deepEqual(
    save.map((item) => [item.name, item.state]),
    [
      ['a.sav', 'same'],
      ['b.sav', 'differs'],
      ['c.sav', 'only'],
    ],
  )
})

test('treats files without a hash as not the same', () => {
  const only = snapshot([entry('x.dat', 'file', null)])
  const comparison = compareSnapshots(only, snapshot([entry('x.dat', 'file', null)]))
  assert.equal(comparison.differingFiles, 1)
})

test('splits paths after each separator', () => {
  assert.deepEqual(splitPathAtSeparators('C:\\Games\\save/a.sav'), [
    'C:\\',
    'Games\\',
    'save/',
    'a.sav',
  ])
})
