import { BATCH_LIMITS } from '../protocol/batch-limits.ts'
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

function chooseAction(source: SyncEntry | undefined, target: SyncEntry | undefined): SyncAction {
  if (!source) {
    return 'keep'
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

function compareOperations(a: SyncPlanEntry, b: SyncPlanEntry): number {
  if (a.action === 'create-directory' && b.action !== 'create-directory') {
    return -1
  }
  if (a.action !== 'create-directory' && b.action === 'create-directory') {
    return 1
  }
  if (a.action === 'create-directory' && b.action === 'create-directory') {
    return a.path.length - b.path.length || compareSyncPaths(a.path, b.path)
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
 * 根据当前快照和显式方向生成确定计划；不读取历史、不执行 IO，也不修改输入。
 * 非法 DTO 抛 Error；业务冲突返回 canExecute=false。未知/溢出总量为 null。
 * 输出复制快照，调用方之后修改输入不会更改本次计划；有效会话/权限由平台复核。
 */
export function createSyncPlan(input: SyncPlanInput): SyncPlan {
  if (!isSyncPlanInput(input)) {
    throw new Error('当前扫描或复制计划输入无效。')
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
    const action = chooseAction(from, to)
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
    if (action === 'replace-file' && input.shouldBackup) {
      if (to?.sizeBytes === null || to?.sizeBytes === undefined) {
        hasUnknownBackup = true
      } else {
        backupBytes += BigInt(to.sizeBytes)
        if (to.sizeBytes > BATCH_LIMITS.maxFileBytes) {
          issues.push({ code: 'resource-limit', side: 'target', path })
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
  if (
    transferFileCount > BATCH_LIMITS.maxFiles ||
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
