import { BATCH_LIMITS } from '../protocol/batch-limits.ts'
import { OperationFailure } from '../result.ts'
import { isPortableFileName } from '../protocol/protocol.ts'
import { SYNC_SCHEMA_VERSION } from './sync-contracts.ts'
import type {
  SyncAction,
  SyncEntry,
  SyncIssue,
  SyncPlan,
  SyncPlanEntry,
  SyncPlanInput,
  SyncSnapshot,
} from './sync-contracts.ts'
import { compareSyncPaths, syncNameKey, syncPathKey } from './sync-paths.ts'
import { isSyncPlanInput } from './sync-validation.ts'

function copySnapshot(value: SyncSnapshot): SyncSnapshot {
  return {
    ...value,
    error: value.error === null ? null : { ...value.error },
    entries: value.entries
      .map((entry) => ({
        ...entry,
        path: [...entry.path],
        error: entry.error === null ? null : { ...entry.error },
      }))
      .sort((a, b) => compareSyncPaths(a.path, b.path)),
  }
}

function inspectSnapshot(
  snapshot: SyncSnapshot,
  side: 'source' | 'target',
  issues: SyncIssue[],
): Map<string, SyncEntry> {
  const names = new Map<string, SyncEntry>()
  if (snapshot.error !== null) {
    issues.push({ code: 'scan-failed', side, path: null })
  }
  for (const entry of snapshot.entries) {
    if (entry.error !== null) {
      issues.push({ code: 'unreadable-entry', side, path: entry.path })
    } else if (entry.kind === 'file' && (entry.sizeBytes === null || entry.sha256 === null)) {
      issues.push({ code: 'unknown-content', side, path: entry.path })
    }
    if (!entry.path.every(isPortableFileName)) {
      issues.push({ code: 'name-conflict', side, path: entry.path })
    }
    const key = syncNameKey(entry.path)
    const previous = names.get(key)
    if (previous) {
      issues.push({ code: 'name-conflict', side, path: previous.path })
      issues.push({ code: 'name-conflict', side, path: entry.path })
    } else {
      names.set(key, entry)
    }
  }
  return names
}

/** 判断这一项是否会改动目标。 */
export function isSyncWriteEntry(entry: SyncPlanEntry): boolean {
  return (
    entry.action === 'create-directory' ||
    entry.action === 'create-file' ||
    entry.action === 'replace-file' ||
    entry.action === 'delete-file' ||
    entry.action === 'delete-directory'
  )
}

/** 判断这个动作是否写入文件内容。 */
export function isSyncFileWrite(action: SyncAction): boolean {
  return action === 'create-file' || action === 'replace-file'
}

function chooseAction(
  source: SyncEntry | undefined,
  target: SyncEntry | undefined,
  shouldDeleteExtras: boolean,
): SyncAction {
  if (!source) {
    if (!shouldDeleteExtras) {
      return 'keep'
    }
    return target?.kind === 'directory' ? 'delete-directory' : 'delete-file'
  }
  if (!target) {
    return source.kind === 'directory' ? 'create-directory' : 'create-file'
  }
  if (source.kind !== target.kind) {
    return 'conflict'
  }
  if (source.kind === 'directory') {
    return 'skip'
  }
  return source.sizeBytes !== null &&
    source.sha256 !== null &&
    source.sizeBytes === target.sizeBytes &&
    source.sha256 === target.sha256
    ? 'skip'
    : 'replace-file'
}

function operationRank(entry: SyncPlanEntry): number {
  if (entry.action === 'create-directory') {
    return 0
  }
  return entry.action === 'delete-file' || entry.action === 'delete-directory' ? 2 : 1
}

// 删除排在最后，写入失败时还没有删除任何条目。
/** 排序规则：先建文件夹（由浅到深），再写文件，最后删除（由深到浅）。 */
function compareOperations(a: SyncPlanEntry, b: SyncPlanEntry): number {
  const rank = operationRank(a) - operationRank(b)
  if (rank !== 0) {
    return rank
  }
  if (operationRank(a) === 0) {
    return a.path.length - b.path.length || compareSyncPaths(a.path, b.path)
  }
  if (operationRank(a) === 2) {
    return b.path.length - a.path.length || compareSyncPaths(a.path, b.path)
  }
  return compareSyncPaths(a.path, b.path)
}

function uniqueIssues(issues: readonly SyncIssue[]): SyncIssue[] {
  return [...new Map(issues.map((issue) => [JSON.stringify(issue), issue])).values()].sort(
    (a, b) =>
      compareSyncPaths(a.path ?? [], b.path ?? []) ||
      (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) ||
      (a.side < b.side ? -1 : a.side > b.side ? 1 : 0),
  )
}

function jsonByteLength(value: unknown): number {
  let count = 0
  for (const character of JSON.stringify(value)) {
    const code = character.codePointAt(0) ?? 0
    count += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return count
}

/**
 * 选出写入前要备份的全部目标文件，包括未变化和只在目标有的文件。
 *
 * @returns 关闭备份、没有写入或目标没有文件时返回空数组。
 */
export function selectSyncBackupFiles(
  plan: Pick<SyncPlan, 'shouldBackup' | 'entries' | 'target'>,
): readonly SyncEntry[] {
  if (!plan.shouldBackup || !plan.entries.some(isSyncWriteEntry)) {
    return []
  }
  return plan.target.entries.filter((entry) => entry.kind === 'file')
}

/**
 * 根据两端快照和方向生成计划，相同输入得到相同计划。
 *
 * @param input 不会被修改；计划保存的是快照的副本。
 * @returns 有冲突时 canExecute 为 false；总量未知或溢出时对应统计为 null。
 * @throws Error 输入格式不合法时抛出。
 */
export function createSyncPlan(input: SyncPlanInput): SyncPlan {
  if (!isSyncPlanInput(input)) {
    throw new OperationFailure('invalid-request', 'The current scan or copy plan input is invalid.')
  }
  const source = copySnapshot(input.source)
  const target = copySnapshot(input.target)
  const issues: SyncIssue[] = []
  if (
    (input.operation === 'copy' && source.deviceId === target.deviceId) ||
    (input.operation === 'restore' && source.deviceId !== target.deviceId)
  ) {
    issues.push({ code: 'invalid-context', side: 'both', path: null })
  }
  inspectSnapshot(source, 'source', issues)
  const targetNames = inspectSnapshot(target, 'target', issues)
  for (const entry of source.entries) {
    const equivalent = targetNames.get(syncNameKey(entry.path))
    if (equivalent && syncPathKey(equivalent.path) !== syncPathKey(entry.path)) {
      issues.push({ code: 'name-conflict', side: 'both', path: entry.path })
      issues.push({ code: 'name-conflict', side: 'both', path: equivalent.path })
    }
  }
  const sourceEntries = new Map(source.entries.map((entry) => [syncPathKey(entry.path), entry]))
  const targetEntries = new Map(target.entries.map((entry) => [syncPathKey(entry.path), entry]))
  const entries: SyncPlanEntry[] = []
  let transferFileCount = 0
  let transferBytes = 0n
  let backupBytes = 0n
  let hasUnknownTransfer = false
  let hasUnknownBackup = false
  for (const key of new Set([...sourceEntries.keys(), ...targetEntries.keys()])) {
    const from = sourceEntries.get(key)
    const to = targetEntries.get(key)
    const path = from?.path ?? to?.path ?? []
    const action = chooseAction(from, to, input.shouldDeleteExtras)
    if (action === 'conflict') {
      issues.push({ code: 'type-conflict', side: 'both', path })
    }
    if (action === 'create-file' || action === 'replace-file') {
      transferFileCount += 1
      if (from?.sizeBytes === null || from?.sizeBytes === undefined) {
        hasUnknownTransfer = true
      } else {
        transferBytes += BigInt(from.sizeBytes)
        if (from.sizeBytes > BATCH_LIMITS.maxFileBytes) {
          issues.push({ code: 'resource-limit', side: 'source', path })
        }
      }
    }
    entries.push({
      path,
      action,
      sourceEntryId: from?.entryId ?? null,
      targetEntryId: to?.entryId ?? null,
    })
  }
  const backupFiles = selectSyncBackupFiles({ shouldBackup: input.shouldBackup, entries, target })
  for (const file of backupFiles) {
    if (file.sizeBytes === null) {
      hasUnknownBackup = true
    } else {
      backupBytes += BigInt(file.sizeBytes)
      if (file.sizeBytes > BATCH_LIMITS.maxFileBytes) {
        issues.push({ code: 'resource-limit', side: 'target', path: file.path })
      }
    }
  }
  if (
    transferFileCount > BATCH_LIMITS.maxFiles ||
    backupFiles.length > BATCH_LIMITS.maxFiles ||
    transferBytes > BigInt(BATCH_LIMITS.maxTotalFileBytes) ||
    backupBytes > BigInt(BATCH_LIMITS.maxTotalFileBytes)
  ) {
    issues.push({ code: 'resource-limit', side: 'both', path: null })
  }
  const result: SyncPlan = {
    ...input,
    schemaVersion: SYNC_SCHEMA_VERSION,
    source,
    target,
    entries: entries.sort(compareOperations),
    issues: uniqueIssues(issues),
    transferFileCount,
    totalFileBytes:
      hasUnknownTransfer || transferBytes > BigInt(Number.MAX_SAFE_INTEGER)
        ? null
        : Number(transferBytes),
    backupFileBytes:
      hasUnknownBackup || backupBytes > BigInt(Number.MAX_SAFE_INTEGER)
        ? null
        : Number(backupBytes),
    canExecute: issues.length === 0,
  }
  if (jsonByteLength(result) > BATCH_LIMITS.maxJsonBytes) {
    return {
      ...result,
      canExecute: false,
      issues: uniqueIssues([
        ...result.issues,
        { code: 'resource-limit', side: 'both', path: null },
      ]),
    }
  }
  return result
}

/** 用同一份快照重新生成计划，只改变只在目标有的条目的处理方式。 */
export function withDeleteExtras(plan: SyncPlan, shouldDeleteExtras: boolean): SyncPlan {
  return createSyncPlan({
    planId: plan.planId,
    projectId: plan.projectId,
    operation: plan.operation,
    direction: plan.direction,
    shouldBackup: plan.shouldBackup,
    shouldDeleteExtras,
    source: plan.source,
    target: plan.target,
  })
}
