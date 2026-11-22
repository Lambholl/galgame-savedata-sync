import { lstat, readFile, rename } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  BATCH_LIMITS,
  DATA_RESET_ITEMS,
  isAppPreferences,
  isLibraryConfig,
  isSyncBackupSettings,
  unreadableFileName,
} from '@savedata-sync/shared'
import type { DataResetItem } from '@savedata-sync/shared'
import { isBackupLocationConfig } from './backup-location.ts'
import { isDeviceIdentity } from './device-identity.ts'
import { isDirectoryRegistry } from './directory-store.ts'
import { isServicePortConfig } from './service-port-settings.ts'

/** 各数据项所在文件的绝对路径。 */
export type DataFilePaths = Readonly<Record<DataResetItem, string>>

interface DataRule {
  readonly maxBytes: number
  readonly isValid: (value: unknown) => boolean
}

// 身份、目录登记和备份设置的上限和各自的读取模块一致；其余文件的读取模块不限大小，这里的上限远大于正常内容。
const RULES: Readonly<Record<DataResetItem, DataRule>> = {
  'device-identity': { maxBytes: 64 * 1024, isValid: isDeviceIdentity },
  directories: { maxBytes: 1024 * 1024, isValid: isDirectoryRegistry },
  library: { maxBytes: 4 * 1024 * 1024, isValid: isLibraryConfig },
  'backup-settings': { maxBytes: BATCH_LIMITS.maxJsonBytes, isValid: isSyncBackupSettings },
  'backup-library': { maxBytes: 128 * 1024, isValid: isBackupLocationConfig },
  'service-settings': { maxBytes: 64 * 1024, isValid: isServicePortConfig },
  preferences: { maxBytes: 64 * 1024, isValid: isAppPreferences },
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

async function isUnreadable(path: string, rule: DataRule): Promise<boolean> {
  let stats
  try {
    stats = await lstat(path)
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return false
    }
    throw error
  }
  if (!stats.isFile() || stats.size > rule.maxBytes) {
    return true
  }
  const bytes = await readFile(path)
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return true
  }
  return !rule.isValid(value)
}

/**
 * 检查各数据文件，把内容读不懂的文件改名为 unreadableFileName 给出的名字，留在原目录。
 * 读不懂指：不是普通文件、超过大小上限、不是 UTF-8 编码的 JSON，或者格式和格式版本不符。
 *
 * @returns 改了名的数据项，按 DATA_RESET_ITEMS 的顺序排列。
 * @throws Error 读取或改名遇到文件系统错误（如没有权限）时抛出，已经改名的文件不还原。
 */
export async function setAsideUnreadableData(
  paths: DataFilePaths,
): Promise<readonly DataResetItem[]> {
  const items: DataResetItem[] = []
  for (const item of DATA_RESET_ITEMS) {
    const path = paths[item]
    if (await isUnreadable(path, RULES[item])) {
      await rename(path, join(dirname(path), unreadableFileName(basename(path), Date.now())))
      console.error(`Set aside an unreadable data file and used defaults: ${item}`)
      items.push(item)
    }
  }
  return items
}
