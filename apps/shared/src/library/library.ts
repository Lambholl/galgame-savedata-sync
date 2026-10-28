import type {
  DirectoryListing,
  DirectoryReference,
  OperationResult,
} from '../protocol/contracts.ts'
import {
  isDirectoryListing,
  isDirectoryReference,
  isOperationResult,
} from '../protocol/validation.ts'
import { isOpaqueId } from '../protocol/protocol.ts'
import { isArrayOf } from '../validation/data-validation.ts'

/** 本机的游戏目录与对端关联；不保存文件清单、哈希或平台路径。 */
export interface LibraryGame {
  readonly id: string
  readonly name: string
  readonly rootId: string | null
  readonly links: readonly GameLink[]
  readonly excludedDevices?: readonly string[]
}
export interface GameLink {
  readonly deviceId: string
  readonly gameId: string
}
/** 地址只用于连接电脑；电脑记住的手机没有监听地址。blocked 是本机的连接开关。 */
export interface SavedDevice {
  readonly id: string
  readonly name: string
  readonly address: string | null
  readonly blocked: boolean
}
export interface LibraryConfig {
  readonly schemaVersion: 1
  readonly games: readonly LibraryGame[]
  readonly devices: readonly SavedDevice[]
}
export interface CatalogGame {
  readonly id: string
  readonly name: string
  readonly root: DirectoryReference | null
}
export interface CatalogLink {
  readonly localGameId: string
  readonly remoteGameId: string
}
export interface DirectoryQuery {
  readonly requestId: string
  readonly rootId: string
  readonly parentId: string | null
}
export interface DirectoryAnswer {
  readonly requestId: string
  readonly result: OperationResult<DirectoryListing>
}
/** 元数据交换兼作通信心跳；目录结果必须对应服务端签发的请求。 */
export interface CatalogPush {
  readonly games: readonly CatalogGame[]
  readonly links: readonly CatalogLink[]
  readonly answer: DirectoryAnswer | null
}
export interface CatalogHello extends CatalogPush {
  readonly deviceId: string
  readonly name: string
}
export interface CatalogReply {
  readonly games: readonly CatalogGame[]
  readonly links: readonly CatalogLink[]
  readonly request: DirectoryQuery | null
}
export interface LibraryPeer {
  readonly device: SavedDevice
  readonly isConnected: boolean
  readonly games: readonly CatalogGame[]
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function text(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 128 &&
    Array.from(value).every((character) => character.charCodeAt(0) >= 32)
  )
}
function unique<T>(items: readonly T[], key: (item: T) => string): boolean {
  return new Set(items.map(key)).size === items.length
}
function isLink(value: unknown): value is GameLink {
  return record(value) && isOpaqueId(value.deviceId) && isOpaqueId(value.gameId)
}
export function isSavedDevice(value: unknown): value is SavedDevice {
  return (
    record(value) &&
    isOpaqueId(value.id) &&
    text(value.name) &&
    typeof value.blocked === 'boolean' &&
    (value.address === null || (typeof value.address === 'string' && value.address.length <= 256))
  )
}
/** 读取前完整校验；损坏配置由调用者报告，不用空配置覆盖。 */
export function isLibraryConfig(value: unknown): value is LibraryConfig {
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.games) ||
    value.games.length > 128 ||
    !Array.isArray(value.devices) ||
    value.devices.length > 32 ||
    !isArrayOf(value.devices, isSavedDevice)
  ) {
    return false
  }
  const games: unknown[] = value.games
  const devices = value.devices
  if (
    !isArrayOf(
      games,
      (item): item is LibraryGame =>
        record(item) &&
        isOpaqueId(item.id) &&
        text(item.name) &&
        (item.rootId === null || isOpaqueId(item.rootId)) &&
        Array.isArray(item.links) &&
        item.links.length <= 32 &&
        isArrayOf(item.links, isLink) &&
        unique(item.links, (link) => link.deviceId) &&
        (item.excludedDevices === undefined ||
          (Array.isArray(item.excludedDevices) &&
            item.excludedDevices.length <= 32 &&
            isArrayOf(item.excludedDevices, isOpaqueId))),
    )
  ) {
    return false
  }
  return (
    unique(games, (item) => item.id) &&
    unique(devices, (item) => item.id) &&
    games.every((item) =>
      item.links.every((link) => devices.some((device) => device.id === link.deviceId)),
    )
  )
}
function isCatalogGame(value: unknown): value is CatalogGame {
  return (
    record(value) &&
    isOpaqueId(value.id) &&
    text(value.name) &&
    (value.root === null || isDirectoryReference(value.root))
  )
}
function isCatalogLink(value: unknown): value is CatalogLink {
  return record(value) && isOpaqueId(value.localGameId) && isOpaqueId(value.remoteGameId)
}
function catalog(value: Record<string, unknown>): boolean {
  return (
    Array.isArray(value.games) &&
    value.games.length <= 128 &&
    isArrayOf(value.games, isCatalogGame) &&
    unique(value.games, (item) => item.id) &&
    Array.isArray(value.links) &&
    value.links.length <= 128 &&
    isArrayOf(value.links, isCatalogLink) &&
    unique(value.links, (item) => item.localGameId)
  )
}
export function isCatalogPush(value: unknown): value is CatalogPush {
  return (
    record(value) &&
    catalog(value) &&
    (value.answer === null ||
      (record(value.answer) &&
        isOpaqueId(value.answer.requestId) &&
        isOperationResult(value.answer.result, isDirectoryListing)))
  )
}
export function isCatalogHello(value: unknown): value is CatalogHello {
  return (
    isCatalogPush(value) &&
    'deviceId' in value &&
    'name' in value &&
    isOpaqueId(value.deviceId) &&
    text(value.name) &&
    value.games.every((item) => item.root === null || item.root.deviceId === value.deviceId)
  )
}
export function isCatalogReply(value: unknown): value is CatalogReply {
  return (
    record(value) &&
    catalog(value) &&
    (value.request === null ||
      (record(value.request) &&
        isOpaqueId(value.request.requestId) &&
        isOpaqueId(value.request.rootId) &&
        (value.request.parentId === null || isOpaqueId(value.request.parentId))))
  )
}
export function isLibraryPeer(value: unknown): value is LibraryPeer {
  return (
    record(value) &&
    isSavedDevice(value.device) &&
    typeof value.isConnected === 'boolean' &&
    Array.isArray(value.games) &&
    value.games.length <= 128 &&
    isArrayOf(value.games, isCatalogGame)
  )
}
export function emptyLibrary(): LibraryConfig {
  return { schemaVersion: 1, games: [], devices: [] }
}
/** 统一地址显示；拒绝账户、路径和非 HTTP 地址，出错时抛普通 Error 供界面显示。 */
export function normalizeHttpAddress(value: string): string {
  const match =
    /^(?:http:\/\/)?(\[[a-f\d:]+\]|(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3})(?::([1-9]\d{0,4}))?\/?$/i.exec(
      value.trim(),
    )
  const host = match?.[1],
    port = match?.[2]
  if (
    !host ||
    (port && Number(port) > 65535) ||
    (!host.startsWith('[') && host.split('.').some((part) => Number(part) > 255))
  ) {
    throw new Error('请输入电脑显示的完整 HTTP 地址。')
  }
  return `http://${host.toLowerCase()}${port ? `:${Number(port)}` : ''}`
}
/** 从本次目录引用生成目录表；失效引用显示为空，不保存文件条目。 */
export function libraryCatalog(
  config: LibraryConfig,
  roots: readonly DirectoryReference[],
): readonly CatalogGame[] {
  return config.games.map((item) => ({
    id: item.id,
    name: item.name,
    root: roots.find((root) => root.rootId === item.rootId) ?? null,
  }))
}
export function libraryLinks(config: LibraryConfig, deviceId: string): readonly CatalogLink[] {
  return config.games.flatMap((item) =>
    item.links
      .filter((link) => link.deviceId === deviceId)
      .map((link) => ({ localGameId: item.id, remoteGameId: link.gameId })),
  )
}
/** 对端明确关联本机游戏后合并反向关系；不会按名称猜测或授予目录写权限。 */
export function mergeCatalogLinks(
  config: LibraryConfig,
  deviceId: string,
  links: readonly CatalogLink[],
): LibraryConfig {
  return {
    ...config,
    games: config.games.map((item) => {
      const link = links.find((value) => value.remoteGameId === item.id)
      const previous = item.links.find((value) => value.deviceId === deviceId)
      if (
        !link &&
        previous &&
        links.some(
          (value) => value.localGameId === previous.gameId && value.remoteGameId !== item.id,
        )
      ) {
        return { ...item, links: item.links.filter((value) => value.deviceId !== deviceId) }
      }
      return link && !item.excludedDevices?.includes(deviceId)
        ? {
            ...item,
            links: [
              ...item.links.filter((value) => value.deviceId !== deviceId),
              { deviceId, gameId: link.localGameId },
            ],
          }
        : item
    }),
  }
}
