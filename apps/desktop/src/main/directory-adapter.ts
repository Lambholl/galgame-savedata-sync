import { randomUUID } from 'node:crypto'
import { open, readdir, realpath } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import { isDirectoryListing, isEntryMetadata, isOpaqueId } from '@savedata-sync/shared'
import type {
  DirectoryListing,
  DirectoryReference,
  EntryMetadata,
  EntryReference,
  FileMetadata,
  OperationResult,
} from '@savedata-sync/shared'
import { DirectoryAccessError, runDirectoryOperation } from './directory-errors.ts'
import {
  getFileIdentity,
  hasSameIdentity,
  inspectLocalPath,
  isWithinDirectory,
} from './directory-paths.ts'
import type { FileIdentity } from './directory-paths.ts'
import { loadDirectoryRegistry, saveDirectoryRegistry } from './directory-store.ts'
import type { DirectoryRegistry, StoredDirectory } from './directory-store.ts'

interface RegisteredEntry {
  readonly rootId: string
  readonly relativePath: string
  readonly identity: FileIdentity
}

/** 原生读流由调用者消费或 destroy；自动关闭文件句柄，不能经 IPC 发送内容或句柄。 */
export interface DirectoryFileRead {
  readonly metadata: FileMetadata
  readonly stream: Readable
}

/**
 * Windows 本地只读目录适配；配置持久化在单独应用目录，源目录没有任何写入 API。
 * 条目引用仅在当前进程有效，重启后须重新列目录；不保存历史清单或文件哈希。
 */
export class WindowsDirectoryAdapter {
  private readonly configPath: string
  private registry: DirectoryRegistry
  private readonly entries = new Map<string, RegisteredEntry>()
  private readonly entryIds = new Map<string, string>()
  private mutation: Promise<void> = Promise.resolve()

  constructor(configPath: string, registry: DirectoryRegistry) {
    this.configPath = configPath
    this.registry = registry
  }

  /** 安装内稳定身份，与 IP 和本次目录读取结果无关。 */
  get deviceId(): string {
    return this.registry.deviceId
  }

  /**
   * 仅供受信任主进程/系统选择器登记绝对路径，不接受 Renderer 路径。
   * 原子保存配置后才更新内存；重新选择同一路径保留 rootId 并重新核实身份。
   */
  async registerDirectory(path: string): Promise<OperationResult<DirectoryReference>> {
    const operation = this.mutation.then(() =>
      runDirectoryOperation(async () => {
        if (typeof path !== 'string' || !isAbsolute(path)) {
          throw new DirectoryAccessError('invalid-request', '请选择有效的本地绝对目录。')
        }
        const stats = await inspectLocalPath(path)
        if (!stats.isDirectory())
          throw new DirectoryAccessError('invalid-request', '所选条目不是目录。')
        const canonicalPath = await realpath(path)
        if (isWithinDirectory(canonicalPath, this.configPath)) {
          throw new DirectoryAccessError('invalid-request', '同步目录不能包含应用的目录配置。')
        }
        const previous = this.registry.roots.find(
          (root) => relative(root.path, canonicalPath) === '',
        )
        const root: StoredDirectory = {
          rootId: previous?.rootId ?? randomUUID(),
          path: canonicalPath,
          identity: getFileIdentity(stats),
        }
        const registry: DirectoryRegistry = {
          ...this.registry,
          roots: [...this.registry.roots.filter((item) => item.rootId !== root.rootId), root],
        }
        await saveDirectoryRegistry(this.configPath, registry)
        this.registry = registry
        // 显式重新选择会使旧条目引用失效，防止替换后的对象沿用旧引用。
        for (const [entryId, entry] of this.entries) {
          if (entry.rootId === root.rootId) {
            this.entries.delete(entryId)
            this.entryIds.delete(this.getEntryKey(root.rootId, entry.relativePath))
          }
        }
        return this.describeRoot(root, 'granted')
      }),
    )
    this.mutation = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  /** 返回公开根描述并重查目录身份；失效目录标 unavailable，不丢弃已保存配置。 */
  async listRoots(): Promise<OperationResult<readonly DirectoryReference[]>> {
    return runDirectoryOperation(async () => {
      const roots: DirectoryReference[] = []
      for (const root of this.registry.roots) {
        try {
          await this.inspectRoot(root.rootId)
          roots.push(this.describeRoot(root, 'granted'))
        } catch {
          roots.push(this.describeRoot(root, 'unavailable'))
        }
      }
      return roots
    })
  }

  /** 仅枚举当前层；失败返回错误，空目录才返回成功空数组；文件夹大小恒为 null。 */
  async listDirectory(
    rootId: string,
    parentId: string | null = null,
  ): Promise<OperationResult<DirectoryListing>> {
    return runDirectoryOperation(async () => {
      const root = await this.inspectRoot(rootId)
      const directoryPath =
        parentId === null ? root.path : (await this.inspectEntry(rootId, parentId)).path
      const directoryStats = await inspectLocalPath(directoryPath)
      if (!directoryStats.isDirectory()) {
        throw new DirectoryAccessError('invalid-request', '只能展开目录条目。')
      }
      const names = await readdir(directoryPath)
      const entries: EntryMetadata[] = []
      for (const name of names) {
        const childPath = join(directoryPath, name)
        const stats = await inspectLocalPath(childPath)
        if (!stats.isFile() && !stats.isDirectory()) {
          throw new DirectoryAccessError('unsupported-operation', '目录包含不支持的文件类型。')
        }
        entries.push(this.describeEntry(root, childPath, stats, parentId))
      }
      await this.inspectRoot(rootId)
      if (
        !hasSameIdentity(await inspectLocalPath(directoryPath), getFileIdentity(directoryStats))
      ) {
        throw new DirectoryAccessError('source-changed', '目录在读取期间发生变化，请刷新。')
      }
      const listing: DirectoryListing = { rootId, parentId, observedAt: Date.now(), entries }
      if (!isDirectoryListing(listing)) {
        throw new DirectoryAccessError('unsupported-operation', '条目元数据超出当前协议支持范围。')
      }
      return listing
    })
  }

  /**
   * 打开已登记条目的只读流，核对路径与句柄身份；不按名称接受任意文件路径。
   * 成功后流所有权交给调用者；读取期间的流错误由调用者处理，内容变化由传输层校验。
   */
  async openFile(reference: EntryReference): Promise<OperationResult<DirectoryFileRead>> {
    return runDirectoryOperation(async () => {
      const root = await this.inspectRoot(reference.rootId)
      const entry = await this.inspectEntry(reference.rootId, reference.entryId)
      if (!entry.stats.isFile())
        throw new DirectoryAccessError('invalid-request', '所选条目不是文件。')
      const handle = await open(entry.path, 'r')
      try {
        const stats = await handle.stat({ bigint: true })
        if (!hasSameIdentity(stats, getFileIdentity(entry.stats))) {
          throw new DirectoryAccessError('source-changed', '文件在打开时发生变化，请刷新目录。')
        }
        await this.inspectEntry(reference.rootId, reference.entryId)
        await this.inspectRoot(reference.rootId)
        const parentPath = relative(root.path, resolve(entry.path, '..'))
        const parentId =
          parentPath === '' ? null : this.entryIds.get(this.getEntryKey(root.rootId, parentPath))
        if (parentId === undefined)
          throw new DirectoryAccessError('not-found', '请先展开文件所在目录。')
        const metadata = this.describeEntry(root, entry.path, stats, parentId)
        if (metadata.kind !== 'file')
          throw new DirectoryAccessError('invalid-request', '所选条目不是文件。')
        return { metadata, stream: handle.createReadStream({ autoClose: true }) }
      } catch (error) {
        await handle.close()
        throw error
      }
    })
  }

  private getEntryKey(rootId: string, relativePath: string): string {
    return `${rootId}\0${relativePath}`
  }

  private describeRoot(
    root: StoredDirectory,
    authorization: DirectoryReference['authorization'],
  ): DirectoryReference {
    return {
      rootId: root.rootId,
      deviceId: this.deviceId,
      displayName: basename(root.path) || root.path.slice(0, 1),
      authorization,
    }
  }

  private describeEntry(
    root: StoredDirectory,
    path: string,
    stats: BigIntStats,
    parentId: string | null,
  ): EntryMetadata {
    const child = relative(root.path, path)
    const key = this.getEntryKey(root.rootId, child)
    const entryId = this.entryIds.get(key) ?? randomUUID()
    const entry: EntryMetadata = {
      rootId: root.rootId,
      entryId,
      parentId,
      name: basename(path),
      modifiedAt: Number(stats.mtimeMs),
      capabilities: {
        canRead: stats.isFile() ? 'unknown' : 'unsupported',
        canList: stats.isDirectory() ? 'unknown' : 'unsupported',
        canCreate: 'unsupported',
        canRename: 'unsupported',
        canDelete: 'unsupported',
      },
      ...(stats.isDirectory()
        ? { kind: 'directory', sizeBytes: null }
        : { kind: 'file', sizeBytes: Number(stats.size) }),
    }
    if (!isEntryMetadata(entry)) {
      throw new DirectoryAccessError('unsupported-operation', '文件属性超出当前协议支持范围。')
    }
    this.entries.set(entryId, {
      rootId: root.rootId,
      relativePath: child,
      identity: getFileIdentity(stats),
    })
    this.entryIds.set(key, entryId)
    return entry
  }

  private async inspectRoot(rootId: string): Promise<StoredDirectory> {
    if (!isOpaqueId(rootId)) throw new DirectoryAccessError('invalid-request', '目录引用格式无效。')
    const root = this.registry.roots.find((item) => item.rootId === rootId)
    if (!root) throw new DirectoryAccessError('not-found', '目录未登记，请先选择目录。')
    const stats = await inspectLocalPath(root.path)
    if (!stats.isDirectory() || !hasSameIdentity(stats, root.identity)) {
      throw new DirectoryAccessError('source-changed', '登记目录已被替换，请重新选择。')
    }
    return root
  }

  private async inspectEntry(
    rootId: string,
    entryId: string,
  ): Promise<{ path: string; stats: BigIntStats }> {
    const root = await this.inspectRoot(rootId)
    if (!isOpaqueId(entryId))
      throw new DirectoryAccessError('invalid-request', '条目引用格式无效。')
    const entry = this.entries.get(entryId)
    if (!entry || entry.rootId !== rootId) {
      throw new DirectoryAccessError('not-found', '条目引用已失效，请刷新目录。')
    }
    const path = resolve(root.path, entry.relativePath)
    if (!isWithinDirectory(root.path, path)) {
      throw new DirectoryAccessError('path-outside-root', '条目不在所选目录内。')
    }
    const stats = await inspectLocalPath(path)
    if (!hasSameIdentity(stats, entry.identity)) {
      throw new DirectoryAccessError('source-changed', '条目已被替换，请刷新目录。')
    }
    return { path, stats }
  }
}

/** 初始化应用目录配置；只在配置不存在时创建身份，损坏/未知版本失败而不重置。 */
export async function createDirectoryAdapter(configPath: string): Promise<WindowsDirectoryAdapter> {
  if (!isAbsolute(configPath))
    throw new DirectoryAccessError('invalid-request', '配置路径必须是绝对路径。')
  const registry = (await loadDirectoryRegistry(configPath)) ?? {
    schemaVersion: 1,
    deviceId: randomUUID(),
    roots: [],
  }
  if (registry.roots.length === 0) await saveDirectoryRegistry(configPath, registry)
  return new WindowsDirectoryAdapter(configPath, registry)
}
