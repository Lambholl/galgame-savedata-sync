import { randomUUID } from 'node:crypto'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { MigrationChain } from '@savedata-sync/shared'

/** 自定义备份库位置文件的文件名，放在数据目录里；没有这个文件时用默认位置。 */
export const BACKUP_LOCATION_FILE = 'backup-library.json'

/** 自定义备份库位置文件的格式版本。 */
export const BACKUP_LOCATION_SCHEMA_VERSION = 1

/** 自定义备份库位置文件的迁移链。 */
export const BACKUP_LOCATION_MIGRATIONS: MigrationChain = {
  baseVersion: 1,
  currentVersion: BACKUP_LOCATION_SCHEMA_VERSION,
  steps: {},
}

/** 自定义备份库位置文件的内容。 */
export interface BackupLocationConfig {
  readonly schemaVersion: typeof BACKUP_LOCATION_SCHEMA_VERSION
  /** 备份库文件夹的绝对路径。 */
  readonly path: string
}

// Windows 长路径的上限是 32767 个字符，位置文件不会更长。
const MAX_PATH_LENGTH = 32767

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

/** 校验自定义备份库位置文件的内容：只有 schemaVersion 为 BACKUP_LOCATION_SCHEMA_VERSION 和绝对路径 path 两个字段。 */
export function isBackupLocationConfig(value: unknown): value is BackupLocationConfig {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 2 &&
    'schemaVersion' in value &&
    value.schemaVersion === BACKUP_LOCATION_SCHEMA_VERSION &&
    'path' in value &&
    typeof value.path === 'string' &&
    value.path.length <= MAX_PATH_LENGTH &&
    isAbsolute(value.path)
  )
}

/**
 * 读取自定义的备份库位置。
 *
 * @returns 文件不存在时返回 null。
 * @throws Error 文件内容不符合 isBackupLocationConfig，或读取遇到其他文件系统错误时抛出。
 */
export async function readBackupLocation(file: string): Promise<string | null> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return null
    }
    throw error
  }
  const value: unknown = JSON.parse(text)
  if (!isBackupLocationConfig(value)) {
    throw new Error('The backup library location file is invalid.')
  }
  return value.path
}

/**
 * 保存自定义的备份库位置；path 为 null 时删除位置文件，改回默认位置。
 *
 * @throws Error 写入、改名或删除失败时抛出，原来的位置文件保持不变。
 */
export async function saveBackupLocation(file: string, path: string | null): Promise<void> {
  if (path === null) {
    await unlink(file).catch((error: unknown) => {
      if (!hasErrorCode(error, 'ENOENT')) {
        throw error
      }
    })
    return
  }
  const config: BackupLocationConfig = { schemaVersion: BACKUP_LOCATION_SCHEMA_VERSION, path }
  if (!isBackupLocationConfig(config)) {
    throw new Error('The backup library location is invalid.')
  }
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(config), { encoding: 'utf8', flag: 'wx' })
    await rename(temporary, file)
  } catch (error) {
    await unlink(temporary).catch(() => {
      /* 临时文件没建成或已经改名，原因以上面的错误为准。 */
    })
    throw error
  }
}
