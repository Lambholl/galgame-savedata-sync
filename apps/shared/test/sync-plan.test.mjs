import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BATCH_LIMITS,
  SYNC_MODIFIED_TOLERANCE_MS,
  createSyncPlan,
  isSyncPlan,
  withSyncPlanChoices,
} from '../src/index.ts'

const DATE = 1700000000000

let nextId = 0
function file(path, sizeBytes = 10, modifiedAt = DATE) {
  return {
    entryId: `e${nextId++}`,
    path: path.split('/'),
    kind: 'file',
    sizeBytes,
    modifiedAt,
    error: null,
  }
}
function directory(path) {
  return {
    entryId: `e${nextId++}`,
    path: path.split('/'),
    kind: 'directory',
    sizeBytes: null,
    modifiedAt: DATE,
    error: null,
  }
}
function snapshot(deviceId, entries) {
  return {
    schemaVersion: 1,
    scanId: 'scan',
    deviceId,
    rootId: 'root',
    observedAt: DATE,
    entries,
    error: null,
  }
}
function plan(source, target, overrides = {}) {
  return createSyncPlan({
    planId: 'plan',
    projectId: 'game',
    operation: 'copy',
    direction: 'listener-to-dialer',
    shouldBackup: false,
    shouldDeleteExtras: false,
    source: snapshot('pc', source),
    target: snapshot('phone', target),
    ...overrides,
  })
}
function actions(result) {
  return result.entries.map((entry) => [entry.path.join('/'), entry.action])
}
function issueCodes(result) {
  return result.issues.map((issue) => issue.code)
}

const SOURCE = [
  directory('save'),
  file('save/same.sav'),
  file('save/changed.sav', 20),
  file('save/new.sav', 30),
]
const TARGET = [
  directory('save'),
  file('save/same.sav'),
  file('save/changed.sav', 15),
  directory('old'),
  file('old/extra.sav', 5),
]

test('保留模式下只写新增和不同的文件，目标多出的条目保留', () => {
  const result = plan(SOURCE, TARGET)
  assert.deepEqual(actions(result), [
    ['old', 'keep'],
    ['old/extra.sav', 'keep'],
    ['save', 'skip'],
    ['save/changed.sav', 'replace-file'],
    ['save/new.sav', 'create-file'],
    ['save/same.sav', 'skip'],
  ])
  assert.equal(result.transferFileCount, 2)
  assert.equal(result.totalFileBytes, 50)
  assert.equal(result.canExecute, true)
})

test('删除模式下删除目标多出的条目，排在全部写入之后且由深到浅', () => {
  const result = plan(SOURCE, [...TARGET, directory('old/deep'), file('old/deep/x.sav')], {
    shouldDeleteExtras: true,
  })
  const writes = actions(result).filter(([, action]) => action !== 'skip')
  assert.deepEqual(writes, [
    ['save/changed.sav', 'replace-file'],
    ['save/new.sav', 'create-file'],
    ['old/deep/x.sav', 'delete-file'],
    ['old/deep', 'delete-directory'],
    ['old/extra.sav', 'delete-file'],
    ['old', 'delete-directory'],
  ])
})

test('新建文件夹排在写文件之前，由浅到深', () => {
  const result = plan([directory('a'), directory('a/b'), file('a/b/c.sav')], [])
  assert.deepEqual(actions(result), [
    ['a', 'create-directory'],
    ['a/b', 'create-directory'],
    ['a/b/c.sav', 'create-file'],
  ])
})

test('大小相同且修改日期在容差内算相同，超出容差或日期未知时覆盖', () => {
  const target = [file('a.sav'), file('b.sav'), file('c.sav')]
  const source = [
    file('a.sav', 10, DATE + SYNC_MODIFIED_TOLERANCE_MS),
    file('b.sav', 10, DATE + SYNC_MODIFIED_TOLERANCE_MS + 1),
    file('c.sav', 10, null),
  ]
  assert.deepEqual(actions(plan(source, target)), [
    ['a.sav', 'skip'],
    ['b.sav', 'replace-file'],
    ['c.sav', 'replace-file'],
  ])
})

test('只差大小写的同名条目和文件与文件夹的类型冲突都阻止执行', () => {
  const caseConflict = plan([file('Save.sav')], [file('save.SAV')])
  assert.deepEqual(issueCodes(caseConflict), ['name-conflict', 'name-conflict'])
  assert.equal(caseConflict.canExecute, false)

  const typeConflict = plan([file('slot')], [directory('slot')])
  assert.deepEqual(actions(typeConflict), [['slot', 'conflict']])
  assert.deepEqual(issueCodes(typeConflict), ['type-conflict'])
  assert.equal(typeConflict.canExecute, false)
})

test('开启备份且有写入时备份目标的全部文件，关闭备份或没有写入时不备份', () => {
  assert.equal(plan(SOURCE, TARGET, { shouldBackup: true }).backupFileBytes, 30)
  assert.equal(plan(SOURCE, TARGET).backupFileBytes, 0)
  const unchanged = [file('a.sav')]
  assert.equal(plan(unchanged, [file('a.sav')], { shouldBackup: true }).backupFileBytes, 0)
})

test('按计划页选项重新生成计划时，备份字节和备份预算问题随备份开关变化', () => {
  const crowded = Array.from({ length: BATCH_LIMITS.maxFiles + 1 }, (_, index) =>
    file(`f${index}.sav`),
  )
  const prepared = plan([file('f0.sav', 20)], crowded)
  assert.equal(prepared.canExecute, true)
  const backedUp = withSyncPlanChoices(prepared, { shouldBackup: true, shouldDeleteExtras: false })
  assert.equal(backedUp.shouldBackup, true)
  assert.equal(backedUp.canExecute, false)
  assert.deepEqual(issueCodes(backedUp), ['resource-limit'])
  const restored = withSyncPlanChoices(backedUp, { shouldBackup: false, shouldDeleteExtras: false })
  assert.deepEqual(restored, prepared)
})

test('单个文件超过上限或文件数超过上限时阻止执行', () => {
  const large = plan([file('big.sav', BATCH_LIMITS.maxFileBytes + 1)], [])
  assert.deepEqual(large.issues, [{ code: 'resource-limit', side: 'source', path: ['big.sav'] }])
  assert.equal(large.canExecute, false)

  const many = Array.from({ length: BATCH_LIMITS.maxFiles + 1 }, (_, index) =>
    file(`f${index}.sav`),
  )
  const crowded = plan(many, [])
  assert.deepEqual(crowded.issues, [{ code: 'resource-limit', side: 'both', path: null }])
  assert.equal(crowded.canExecute, false)
})

test('复制的两端是同一设备、恢复的两端不是同一设备时阻止执行', () => {
  const copy = plan([file('a.sav')], [], { target: snapshot('pc', []) })
  assert.deepEqual(issueCodes(copy), ['invalid-context'])
  const restore = plan([file('a.sav')], [], {
    operation: 'restore',
    direction: 'local-restore',
    shouldBackup: true,
    shouldDeleteExtras: true,
  })
  assert.deepEqual(issueCodes(restore), ['invalid-context'])
})

test('恢复计划删除目标目录里多出的文件与目录并保持可校验', () => {
  const restore = plan(
    [file('slot1.sav', 20, 200)],
    [file('slot1.sav', 10, 100), directory('extra-dir'), file('extra-dir/extra.sav', 5, 100)],
    {
      operation: 'restore',
      direction: 'local-restore',
      shouldBackup: true,
      shouldDeleteExtras: true,
      target: snapshot('pc', [
        file('slot1.sav', 10, 100),
        directory('extra-dir'),
        file('extra-dir/extra.sav', 5, 100),
      ]),
    },
  )
  assert.equal(restore.canExecute, true)
  assert.equal(isSyncPlan(restore), true)
  assert.deepEqual(
    restore.entries.map((entry) => [entry.path.join('/'), entry.action]),
    [
      ['slot1.sav', 'replace-file'],
      ['extra-dir/extra.sav', 'delete-file'],
      ['extra-dir', 'delete-directory'],
    ],
  )
})
