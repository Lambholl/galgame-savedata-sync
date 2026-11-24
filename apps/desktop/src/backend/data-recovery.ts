import { lstat, readFile, rename } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  BACKUP_SETTINGS_SCHEMA_VERSION,
  BATCH_LIMITS,
  DATA_RESET_ITEMS,
  LIBRARY_SCHEMA_VERSION,
  isLibraryConfig,
  isNewerSchemaVersion,
  isSyncBackupSettings,
  unreadableFileName,
} from '@savedata-sync/shared'
import type { DataResetItem, VersionedDataItem } from '@savedata-sync/shared'
import { BACKUP_LOCATION_SCHEMA_VERSION, isBackupLocationConfig } from './backup-location.ts'
import { DEVICE_IDENTITY_SCHEMA_VERSION, isDeviceIdentity } from './device-identity.ts'
import { DIRECTORY_REGISTRY_SCHEMA_VERSION, isDirectoryRegistry } from './directory-store.ts'

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
  /** 当前格式版本；没有 schemaVersion 的数据项为 null。 */
  readonly schemaVersion: number | null
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
    schemaVersion: DEVICE_IDENTITY_SCHEMA_VERSION,
  },
  directories: {
    maxBytes: 1024 * 1024,
    isValid: isDirectoryRegistry,
    schemaVersion: DIRECTORY_REGISTRY_SCHEMA_VERSION,
  },
  library: {
    maxBytes: 4 * 1024 * 1024,
    isValid: isLibraryConfig,
    schemaVersion: LIBRARY_SCHEMA_VERSION,
  },
  'backup-settings': {
    maxBytes: BATCH_LIMITS.maxJsonBytes,
    isValid: isSyncBackupSettings,
    schemaVersion: BACKUP_SETTINGS_SCHEMA_VERSION,
  },
  'backup-library': {
    maxBytes: 128 * 1024,
    isValid: isBackupLocationConfig,
    schemaVersion: BACKUP_LOCATION_SCHEMA_VERSION,
  },
  'service-settings': { maxBytes: 64 * 1024, isValid: isJsonObject, schemaVersion: null },
  preferences: { maxBytes: 64 * 1024, isValid: isJsonObject, schemaVersion: null },
}

type DataState = 'missing' | 'readable' | 'newer' | 'unreadable'

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

async function inspect(path: string, rule: DataRule): Promise<DataState> {
  let stats
  try {
    stats = await lstat(path)
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return 'missing'
    }
    throw error
  }
  if (!stats.isFile() || stats.size > rule.maxBytes) {
    return 'unreadable'
  }
  const bytes = await readFile(path)
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return 'unreadable'
  }
  if (rule.isValid(value)) {
    return 'readable'
  }
  return rule.schemaVersion !== null && isNewerSchemaVersion(value, rule.schemaVersion)
    ? 'newer'
    : 'unreadable'
}

/**
 * 检查各数据文件，把内容读不懂的文件改名为 unreadableFileName 给出的名字，留在原目录。
 * 读不懂指：不是普通文件、超过大小上限、不是 UTF-8 编码的 JSON，或者格式和格式版本不符。
 *
 * @returns 改了名的数据项，按 DATA_RESET_ITEMS 的顺序排列。
 * @throws NewerDataError 有数据文件由更新版本的应用写入时抛出，这时不改名任何文件。
 * @throws Error 读取或改名遇到文件系统错误（如没有权限）时抛出，已经改名的文件不还原。
 */
export async function setAsideUnreadableData(
  paths: DataFilePaths,
): Promise<readonly DataResetItem[]> {
  const unreadable: DataResetItem[] = []
  const newer: VersionedDataItem[] = []
  for (const item of DATA_RESET_ITEMS) {
    const state = await inspect(paths[item], RULES[item])
    if (state === 'unreadable') {
      unreadable.push(item)
    } else if (state === 'newer') {
      // 只有带 schemaVersion 的数据项会得到 newer。
      newer.push(item as VersionedDataItem)
    }
  }
  if (newer.length > 0) {
    throw new NewerDataError(newer)
  }
  for (const item of unreadable) {
    const path = paths[item]
    await rename(path, join(dirname(path), unreadableFileName(basename(path), Date.now())))
    console.error(`Set aside an unreadable data file and used defaults: ${item}`)
  }
  return unreadable
}
