import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { isOpaqueId } from '@savedata-sync/shared'
import type { FileIdentity } from './directory-paths.ts'
import { hasSameIdentity, isWithinDirectory } from './directory-paths.ts'
import { DirectoryAccessError } from './directory-errors.ts'

/** 一个已登记目录的配置。 */
export interface StoredDirectory {
  readonly rootId: string
  readonly path: string
  readonly identity: FileIdentity
}

/** 目录配置文件（schema 1）：安装 ID 和用户选定的根目录。 */
export interface DirectoryRegistry {
  readonly schemaVersion: 1
  readonly deviceId: string
  readonly roots: readonly StoredDirectory[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStoredDirectory(value: unknown): value is StoredDirectory {
  return (
    isRecord(value) &&
    Object.keys(value).length === 3 &&
    isOpaqueId(value.rootId) &&
    typeof value.path === 'string' &&
    isAbsolute(value.path) &&
    isRecord(value.identity) &&
    Object.keys(value.identity).length === 2 &&
    typeof value.identity.dev === 'string' &&
    /^\d+$/.test(value.identity.dev) &&
    typeof value.identity.ino === 'string' &&
    /^\d+$/.test(value.identity.ino)
  )
}

function isRegistry(value: unknown): value is DirectoryRegistry {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 3 ||
    value.schemaVersion !== 1 ||
    !isOpaqueId(value.deviceId) ||
    !Array.isArray(value.roots)
  ) {
    return false
  }
  const roots: StoredDirectory[] = []
  for (const root of value.roots) {
    if (!isStoredDirectory(root)) {
      return false
    }
    roots.push(root)
  }
  return new Set(roots.map((root) => root.rootId)).size === roots.length
}

function assertConfigOutsideRoots(configPath: string, registry: DirectoryRegistry): void {
  if (registry.roots.some((root) => isWithinDirectory(root.path, configPath))) {
    throw new DirectoryAccessError(
      'invalid-request',
      'The configuration file cannot be stored in the selected sync directory.',
    )
  }
}

/**
 * 读取目录配置。
 *
 * @returns 配置；文件不存在时返回 null。
 * @throws DirectoryAccessError schema 未知、内容损坏或文件是链接时抛出，原文件保留。
 */
export async function loadDirectoryRegistry(configPath: string): Promise<DirectoryRegistry | null> {
  let stats
  try {
    stats = await lstat(configPath, { bigint: true })
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 1024n * 1024n) {
    throw new DirectoryAccessError(
      'invalid-request',
      'The directory configuration file type or size is invalid.',
    )
  }
  const handle = await open(configPath, 'r')
  try {
    if (
      !hasSameIdentity(await handle.stat({ bigint: true }), {
        dev: stats.dev.toString(),
        ino: stats.ino.toString(),
      })
    ) {
      throw new DirectoryAccessError(
        'source-changed',
        'The directory configuration changed while reading.',
      )
    }
    const value: unknown = JSON.parse(await handle.readFile('utf8'))
    if (!isRegistry(value)) {
      throw new DirectoryAccessError(
        'invalid-request',
        'The directory configuration format or version is invalid.',
      )
    }
    assertConfigOutsideRoots(configPath, value)
    return value
  } finally {
    await handle.close()
  }
}

/** 先写同目录的临时文件再替换原文件；出错时原配置保留。同一文件的保存不能并发。 */
export async function saveDirectoryRegistry(
  configPath: string,
  registry: DirectoryRegistry,
): Promise<void> {
  assertConfigOutsideRoots(configPath, registry)
  await mkdir(dirname(configPath), { recursive: true })
  const temporaryPath = join(dirname(configPath), `.directory-config-${randomUUID()}.tmp`)
  const handle = await open(temporaryPath, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(registry)}\n`, 'utf8')
    await handle.sync()
  } catch (error) {
    await handle.close()
    await unlink(temporaryPath)
    throw error
  }
  await handle.close()
  try {
    await rename(temporaryPath, configPath)
  } catch (error) {
    await unlink(temporaryPath)
    throw error
  }
}
