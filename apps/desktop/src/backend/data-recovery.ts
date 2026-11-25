import { randomUUID } from 'node:crypto'
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  BACKUP_SETTINGS_MIGRATIONS,
  BATCH_LIMITS,
  DATA_RESET_ITEMS,
  LIBRARY_MIGRATIONS,
  isLibraryConfig,
  isSyncBackupSettings,
  migrateData,
  unreadableFileName,
} from '@savedata-sync/shared'
import type { DataResetItem, MigrationChain, VersionedDataItem } from '@savedata-sync/shared'
import { BACKUP_LOCATION_MIGRATIONS, isBackupLocationConfig } from './backup-location.ts'
import { DEVICE_IDENTITY_MIGRATIONS, isDeviceIdentity } from './device-identity.ts'
import { DIRECTORY_REGISTRY_MIGRATIONS, isDirectoryRegistry } from './directory-store.ts'

/** 各数据项所在文件的绝对路径。 */
export type DataFilePaths = Readonly<Record<DataResetItem, string>>

/** 有数据文件由更新版本的应用写入；抛出时所有数据文件都没有被改动。 */
export class NewerDataError extends Error {
  /** 由更新版本写入的数据项，按 DATA_RESET_ITEMS 的顺序排列。 */
  readonly items: readonly VersionedDataItem[]

  constructor(items: readonly VersionedDataItem[]) {
    super(`Data files were written by a newer app version: ${items.join(', ')}`)
    this.name = 'NewerDataError'
    this.items = items
  }
}

interface DataRule {
  readonly maxBytes: number
  readonly isValid: (value: unknown) => boolean
  /** 迁移链；没有 schemaVersion 的数据项为 null。 */
  readonly migrations: MigrationChain | null
}

function isJsonObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// 身份、目录登记和备份设置的上限和各自的读取模块一致；其余文件的读取模块不限大小，这里的上限远大于正常内容。
// 端口和界面偏好的读取模块把无效或不认识的字段读成默认值，所以只要求是 JSON 对象。
const RULES: Readonly<Record<DataResetItem, DataRule>> = {
  'device-identity': {
    maxBytes: 64 * 1024,
    isValid: isDeviceIdentity,
    migrations: DEVICE_IDENTITY_MIGRATIONS,
  },
  directories: {
    maxBytes: 1024 * 1024,
    isValid: isDirectoryRegistry,
    migrations: DIRECTORY_REGISTRY_MIGRATIONS,
  },
  library: {
    maxBytes: 4 * 1024 * 1024,
    isValid: isLibraryConfig,
    migrations: LIBRARY_MIGRATIONS,
  },
  'backup-settings': {
    maxBytes: BATCH_LIMITS.maxJsonBytes,
    isValid: isSyncBackupSettings,
    migrations: BACKUP_SETTINGS_MIGRATIONS,
  },
  'backup-library': {
    maxBytes: 128 * 1024,
    isValid: isBackupLocationConfig,
    migrations: BACKUP_LOCATION_MIGRATIONS,
  },
  'service-settings': { maxBytes: 64 * 1024, isValid: isJsonObject, migrations: null },
  preferences: { maxBytes: 64 * 1024, isValid: isJsonObject, migrations: null },
}

/** migrated 时 value 是迁移到当前版本、要写回文件的内容。 */
type DataState =
  | { readonly status: 'missing' | 'readable' | 'newer' | 'unreadable' }
  | { readonly status: 'migrated'; readonly value: unknown }

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

async function inspect(path: string, rule: DataRule): Promise<DataState> {
  let stats
  try {
    stats = await lstat(path)
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return { status: 'missing' }
    }
    throw error
  }
  if (!stats.isFile() || stats.size > rule.maxBytes) {
    return { status: 'unreadable' }
  }
  const bytes = await readFile(path)
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return { status: 'unreadable' }
  }
  if (rule.migrations === null) {
    return { status: rule.isValid(value) ? 'readable' : 'unreadable' }
  }
  const result = migrateData(value, rule.migrations, rule.isValid)
  return result.status === 'current'
    ? { status: 'readable' }
    : result.status === 'migrated'
      ? { status: 'migrated', value: result.value }
      : { status: result.status }
}

// 和各数据的保存方式一样先写临时文件再改名，写到一半退出时原文件不受影响。
async function replaceJson(path: string, value: unknown): Promise<void> {
  const temporaryPath = join(dirname(path), `.migrating-${randomUUID()}.tmp`)
  const handle = await open(temporaryPath, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8')
    await handle.sync()
  } catch (error) {
    await handle.close()
    await unlink(temporaryPath)
    throw error
  }
  await handle.close()
  try {
    await rename(temporaryPath, path)
  } catch (error) {
    await unlink(temporaryPath)
    throw error
  }
}

/**
 * 检查各数据文件：旧版本的数据按迁移链迁移到当前版本后写回原文件，内容读不懂的文件改名为 unreadableFileName 给出的名字，留在原目录。
 * 读不懂指：不是普通文件、超过大小上限、不是 UTF-8 编码的 JSON、格式和格式版本不符、版本低于迁移链的基线，或者迁移失败。
 *
 * @returns 改了名的数据项，按 DATA_RESET_ITEMS 的顺序排列。
 * @throws NewerDataError 有数据文件由更新版本的应用写入时抛出，这时不迁移、不改名任何文件。
 * @throws Error 读取、写回或改名遇到文件系统错误（如没有权限）时抛出，已经写回或改名的文件不还原。
 */
export async function setAsideUnreadableData(
  paths: DataFilePaths,
): Promise<readonly DataResetItem[]> {
  const unreadable: DataResetItem[] = []
  const newer: VersionedDataItem[] = []
  const migrated = new Map<DataResetItem, unknown>()
  for (const item of DATA_RESET_ITEMS) {
    const state = await inspect(paths[item], RULES[item])
    if (state.status === 'unreadable') {
      unreadable.push(item)
    } else if (state.status === 'newer') {
      // 只有带 schemaVersion 的数据项会得到 newer。
      newer.push(item as VersionedDataItem)
    } else if (state.status === 'migrated') {
      migrated.set(item, state.value)
    }
  }
  if (newer.length > 0) {
    throw new NewerDataError(newer)
  }
  for (const [item, value] of migrated) {
    await replaceJson(paths[item], value)
    console.info(`Migrated a data file to the current format: ${item}`)
  }
  for (const item of unreadable) {
    const path = paths[item]
    await rename(path, join(dirname(path), unreadableFileName(basename(path), Date.now())))
    console.error(`Set aside an unreadable data file and used defaults: ${item}`)
  }
  return unreadable
}
