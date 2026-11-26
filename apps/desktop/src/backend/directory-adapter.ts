import { randomUUID } from 'node:crypto'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import {
  isDirectoryListing,
  isEntryMetadata,
  isOpaqueId,
  isPortableFileName,
} from '@savedata-sync/shared'
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
import {
  DIRECTORY_REGISTRY_SCHEMA_VERSION,
  loadDirectoryRegistry,
  saveDirectoryRegistry,
} from './directory-store.ts'
import { loadDeviceId } from './device-identity.ts'
import type { DirectoryRegistry, StoredDirectory } from './directory-store.ts'

interface RegisteredEntry {
  readonly rootId: string
  readonly relativePath: string
  readonly identity: FileIdentity
}

/** 打开文件的结果：读流由调用方读完或 destroy，文件句柄随流关闭。 */
export interface DirectoryFileRead {
  readonly metadata: FileMetadata
  readonly stream: Readable
  /** 读完后重新核对文件的身份、大小和修改时间；结果只反映检查那一刻的状态。 */
  readonly verifyUnchanged: () => Promise<void>
}

/** 一个已登记父目录的定位结果，方法都只读。 */
export interface NativeDirectoryLocation {
  readonly rootId: string
  readonly parentId: string | null
  readonly path: string
  readonly identity: FileIdentity
  readonly verify: () => Promise<void>
  readonly describeFile: (name: string, identity: FileIdentity) => Promise<FileMetadata>
}

/** 桌面端本地目录的只读访问：登记、列出和读取目录。条目引用只在当前进程有效。 */
export class DesktopDirectoryAdapter {
  private readonly configPath: string
  readonly #deviceId: string
  private registry: DirectoryRegistry
  private readonly entries = new Map<string, RegisteredEntry>()
  private readonly entryIds = new Map<string, string>()
  private readonly privateDirectories = new Set<string>()
  private mutation: Promise<void> = Promise.resolve()

  constructor(configPath: string, registry: DirectoryRegistry, deviceId: string) {
    this.configPath = configPath
    this.registry = registry
    this.#deviceId = deviceId
  }

  /** 这次安装的稳定设备 ID。 */
  get deviceId(): string {
    return this.#deviceId
  }

  /** 检查缓存目录与所有已登记的根目录互不包含，有包含关系时抛错。 */
  assertCacheIsolated(cachePath: string): void {
    if (
      !isAbsolute(cachePath) ||
      this.registry.roots.some(
        (root) =>
          isWithinDirectory(root.path, cachePath) || isWithinDirectory(cachePath, root.path),
      )
    ) {
      throw new DirectoryAccessError(
        'path-outside-root',
        'The archive cache must be separate from selected directories.',
      )
    }
  }

  /** 登记应用私有目录；此后它和它的父子目录都不能登记为根目录。 */
  excludePrivateDirectory(path: string): void {
    this.assertCacheIsolated(path)
    this.privateDirectories.add(path)
  }

  /**
   * 把登记过的私有目录 previous 换成 next；previous 没有登记过时只登记 next。
   *
   * @returns 撤销这次替换、恢复原来登记的函数。
   * @throws DirectoryAccessError next 和已登记的根目录或其他私有目录互相包含时抛出，错误码为 path-outside-root，登记不变。
   */
  replacePrivateDirectory(previous: string, next: string): () => void {
    this.assertCacheIsolated(next)
    if (
      [...this.privateDirectories].some(
        (directory) =>
          directory !== previous &&
          (isWithinDirectory(directory, next) || isWithinDirectory(next, directory)),
      )
    ) {
      throw new DirectoryAccessError(
        'path-outside-root',
        'The backup library must be separate from the app data folders.',
      )
    }
    const wasRegistered = this.privateDirectories.delete(previous)
    this.privateDirectories.add(next)
    return () => {
      this.privateDirectories.delete(next)
      if (wasRegistered) {
        this.privateDirectories.add(previous)
      }
    }
  }

  private assertNotPrivate(path: string): void {
    if (
      [...this.privateDirectories].some(
        (directory) => isWithinDirectory(directory, path) || isWithinDirectory(path, directory),
      )
    ) {
      throw new DirectoryAccessError(
        'path-outside-root',
        'The sync directory must be separate from the app-private backup area.',
      )
    }
  }

  /**
   * 把绝对路径登记为根目录，配置保存成功后才生效。路径先解析成真实路径，经过符号链接或目录联接选择的目录按链接目标登记。
   * 重新登记同一路径时保留 rootId，并让这个根下的旧条目引用失效。
   */
  async registerDirectory(path: string): Promise<OperationResult<DirectoryReference>> {
    const operation = this.mutation.then(() =>
      runDirectoryOperation(async () => {
        if (typeof path !== 'string' || !isAbsolute(path)) {
          throw new DirectoryAccessError(
            'invalid-request',
            'Select a valid absolute local directory.',
          )
        }
        // 系统选择器返回的路径可能经过符号链接（如 /home 本身是链接、Wine 前缀里的盘符链接）；
        // 登记解析后的路径，之后访问时路径中途再出现链接仍按越界拒绝。
        const canonicalPath = await realpath(path)
        const stats = await inspectLocalPath(canonicalPath)
        if (!stats.isDirectory()) {
          throw new DirectoryAccessError(
            'invalid-request',
            'The selected entry is not a directory.',
          )
        }
        this.assertNotPrivate(canonicalPath)
        if (isWithinDirectory(canonicalPath, this.configPath)) {
          throw new DirectoryAccessError(
            'invalid-request',
            "The sync directory cannot contain the app's directory configuration.",
          )
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
        // 目录可能已被替换，旧条目引用不能沿用到新对象上。
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

  /** 列出已登记的根目录并重新核对身份；身份不符或无法访问的标为 unavailable。 */
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

  /** 列出目录的一层，只含普通文件和文件夹；文件夹的大小为 null。 */
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
        throw new DirectoryAccessError('invalid-request', 'Only directory entries can be expanded.')
      }
      const names = await readdir(directoryPath)
      const entries: EntryMetadata[] = []
      for (const name of names) {
        const childPath = join(directoryPath, name)
        // 符号链接、目录联接、FIFO、套接字和设备文件不同步，跟 .nomedia 一样不列出。
        // 跟随链接可能读写到根目录以外，读 FIFO 和设备文件会阻塞或读不完。
        const linkStats = await lstat(childPath)
        if (!linkStats.isFile() && !linkStats.isDirectory()) {
          continue
        }
        const stats = await inspectLocalPath(childPath)
        entries.push(this.describeEntry(root, childPath, stats, parentId))
      }
      await this.inspectRoot(rootId)
      if (
        !hasSameIdentity(await inspectLocalPath(directoryPath), getFileIdentity(directoryStats))
      ) {
        throw new DirectoryAccessError(
          'source-changed',
          'The directory changed while reading. Refresh it.',
        )
      }
      const listing: DirectoryListing = { rootId, parentId, observedAt: Date.now(), entries }
      if (!isDirectoryListing(listing)) {
        throw new DirectoryAccessError(
          'unsupported-operation',
          'Entry metadata exceeds the range supported by the current protocol.',
        )
      }
      return listing
    })
  }

  /** 打开条目的只读流，并核对路径与句柄是同一个文件；读取中的流错误由调用方处理。 */
  async openFile(reference: EntryReference): Promise<OperationResult<DirectoryFileRead>> {
    return runDirectoryOperation(async () => {
      const root = await this.inspectRoot(reference.rootId)
      const entry = await this.inspectEntry(reference.rootId, reference.entryId)
      if (!entry.stats.isFile()) {
        throw new DirectoryAccessError('invalid-request', 'The selected entry is not a file.')
      }
      const handle = await open(entry.path, 'r')
      try {
        const stats = await handle.stat({ bigint: true })
        if (!hasSameIdentity(stats, getFileIdentity(entry.stats))) {
          throw new DirectoryAccessError(
            'source-changed',
            'The file changed while opening. Refresh the directory.',
          )
        }
        await this.inspectEntry(reference.rootId, reference.entryId)
        await this.inspectRoot(reference.rootId)
        const parentPath = relative(root.path, resolve(entry.path, '..'))
        const parentId =
          parentPath === '' ? null : this.entryIds.get(this.getEntryKey(root.rootId, parentPath))
        if (parentId === undefined) {
          throw new DirectoryAccessError('not-found', "Expand the file's directory first.")
        }
        const metadata = this.describeEntry(root, entry.path, stats, parentId)
        if (metadata.kind !== 'file') {
          throw new DirectoryAccessError('invalid-request', 'The selected entry is not a file.')
        }
        return {
          metadata,
          stream: handle.createReadStream({ autoClose: true, highWaterMark: 65536 }),
          verifyUnchanged: async () => {
            const current = await this.inspectEntry(reference.rootId, reference.entryId)
            await this.inspectRoot(reference.rootId)
            if (
              !hasSameIdentity(current.stats, getFileIdentity(stats)) ||
              current.stats.size !== stats.size ||
              current.stats.mtimeNs !== stats.mtimeNs ||
              current.stats.ctimeNs !== stats.ctimeNs
            ) {
              throw new DirectoryAccessError(
                'source-changed',
                'The source file changed while reading. Refresh it.',
              )
            }
          },
        }
      } catch (error) {
        await handle.close()
        throw error
      }
    })
  }

  /**
   * 定位已登记的父目录，记录根和父目录的身份。
   * 返回结果的 verify 在适配器关闭后仍可用；describeFile 只登记身份匹配的普通文件，不校验内容。
   */
  async locateNativeDirectory(
    rootId: string,
    parentId: string | null = null,
  ): Promise<NativeDirectoryLocation> {
    const root = await this.inspectRoot(rootId)
    const path = parentId === null ? root.path : (await this.inspectEntry(rootId, parentId)).path
    const stats = await inspectLocalPath(path)
    if (!stats.isDirectory()) {
      throw new DirectoryAccessError(
        'invalid-request',
        'The target parent entry is not a directory.',
      )
    }
    const identity = Object.freeze(getFileIdentity(stats))
    const verify = async (): Promise<void> => {
      const current = await this.inspectRoot(rootId)
      if (
        relative(current.path, root.path) !== '' ||
        !hasSameIdentity(await inspectLocalPath(root.path), root.identity) ||
        !hasSameIdentity(await inspectLocalPath(path), identity)
      ) {
        throw new DirectoryAccessError('source-changed', 'The native directory identity changed.')
      }
    }
    await verify()
    return Object.freeze({
      rootId,
      parentId,
      path,
      identity,
      verify,
      describeFile: async (name: string, expected: FileIdentity): Promise<FileMetadata> => {
        if (!isPortableFileName(name)) {
          throw new DirectoryAccessError('invalid-request', 'The new file name is invalid.')
        }
        await verify()
        const filePath = join(path, name)
        const fileStats = await inspectLocalPath(filePath)
        if (!fileStats.isFile() || !hasSameIdentity(fileStats, expected)) {
          throw new DirectoryAccessError('source-changed', 'The new file identity changed.')
        }
        const metadata = this.describeEntry(root, filePath, fileStats, parentId)
        if (metadata.kind !== 'file') {
          throw new DirectoryAccessError('source-changed', 'The new file type changed.')
        }
        await verify()
        return metadata
      },
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
      displayPath: root.path,
      parentName: basename(dirname(root.path)) || basename(root.path) || root.path.slice(0, 1),
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
    const previousId = this.entryIds.get(key)
    const previous = previousId ? this.entries.get(previousId) : undefined
    const entryId =
      previousId && previous && hasSameIdentity(stats, previous.identity)
        ? previousId
        : randomUUID()
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
      throw new DirectoryAccessError(
        'unsupported-operation',
        'File attributes exceed the range supported by the current protocol.',
      )
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
    if (!isOpaqueId(rootId)) {
      throw new DirectoryAccessError(
        'invalid-request',
        'The directory reference format is invalid.',
      )
    }
    const root = this.registry.roots.find((item) => item.rootId === rootId)
    if (!root) {
      throw new DirectoryAccessError(
        'not-found',
        'The directory is not registered. Select it first.',
      )
    }
    this.assertNotPrivate(root.path)
    const stats = await inspectLocalPath(root.path)
    if (!stats.isDirectory() || !hasSameIdentity(stats, root.identity)) {
      throw new DirectoryAccessError(
        'source-changed',
        'The registered directory was replaced. Select it again.',
      )
    }
    return root
  }

  private async inspectEntry(
    rootId: string,
    entryId: string,
  ): Promise<{ path: string; stats: BigIntStats }> {
    const root = await this.inspectRoot(rootId)
    if (!isOpaqueId(entryId)) {
      throw new DirectoryAccessError('invalid-request', 'The entry reference format is invalid.')
    }
    const entry = this.entries.get(entryId)
    if (!entry || entry.rootId !== rootId) {
      throw new DirectoryAccessError(
        'not-found',
        'The entry reference expired. Refresh the directory.',
      )
    }
    const path = resolve(root.path, entry.relativePath)
    if (!isWithinDirectory(root.path, path)) {
      throw new DirectoryAccessError(
        'path-outside-root',
        'The entry is outside the selected directory.',
      )
    }
    const stats = await inspectLocalPath(path)
    if (!hasSameIdentity(stats, entry.identity)) {
      throw new DirectoryAccessError(
        'source-changed',
        'The entry was replaced. Refresh the directory.',
      )
    }
    return { path, stats }
  }
}

/**
 * 读取设备身份和目录配置并创建适配器。
 *
 * @param configPath 目录配置文件的绝对路径；文件不存在时按没有登记目录保存一份。
 * @param identityPath 设备身份文件的绝对路径，默认是目录配置旁边的 `identity.json`；文件不存在时生成新的设备 ID。
 * @throws DirectoryAccessError 路径不是绝对路径，或者设备身份、目录配置损坏或版本未知时抛出。
 */
export async function createDirectoryAdapter(
  configPath: string,
  identityPath = join(dirname(configPath), 'identity.json'),
): Promise<DesktopDirectoryAdapter> {
  if (!isAbsolute(configPath)) {
    throw new DirectoryAccessError('invalid-request', 'The configuration path must be absolute.')
  }
  const deviceId = await loadDeviceId(identityPath)
  const registry = (await loadDirectoryRegistry(configPath)) ?? {
    schemaVersion: DIRECTORY_REGISTRY_SCHEMA_VERSION,
    roots: [],
  }
  if (registry.roots.length === 0) {
    await saveDirectoryRegistry(configPath, registry)
  }
  return new DesktopDirectoryAdapter(configPath, registry, deviceId)
}
