import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { isOpaqueId } from '@savedata-sync/shared'
import type { FileIdentity } from './directory-paths.ts'
import { hasSameIdentity, isWithinDirectory } from './directory-paths.ts'
import { DirectoryAccessError } from './directory-errors.ts'

/** 只在主进程保存的配置，禁止把 path/identity 暴露给 Renderer 或 HTTP。 */
export interface StoredDirectory {
  readonly rootId: string
  readonly path: string
  readonly identity: FileIdentity
}

/** schema 1 只保存安装 ID 和用户选定根目录，不保存条目索引或哈希。 */
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
    throw new DirectoryAccessError('invalid-request', '配置文件不能存放在所选同步目录中。')
  }
}

/**
 * 读取本机配置；未知 schema/损坏内容/链接文件一律失败，不覆盖原配置。
 * 仅不存在时返回 null，其他错误保留 cause 并由初始化调用者处理。
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
    throw new DirectoryAccessError('invalid-request', '目录配置文件类型或大小无效。')
  }
  const handle = await open(configPath, 'r')
  try {
    if (
      !hasSameIdentity(await handle.stat({ bigint: true }), {
        dev: stats.dev.toString(),
        ino: stats.ino.toString(),
      })
    ) {
      throw new DirectoryAccessError('source-changed', '目录配置在读取时发生变化。')
    }
    const value: unknown = JSON.parse(await handle.readFile('utf8'))
    if (!isRegistry(value)) {
      throw new DirectoryAccessError('invalid-request', '目录配置格式或版本无效。')
    }
    assertConfigOutsideRoots(configPath, value)
    return value
  } finally {
    await handle.close()
  }
}

/**
 * 把完整配置写到同目录独占临时文件后替换；不会写入任何所选根目录。
 * 调用者须串行化配置变更；错误时保留旧配置，不静默重建或迁移未知 schema。
 */
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
