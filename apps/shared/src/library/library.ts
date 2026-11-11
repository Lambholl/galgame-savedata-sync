import type { DirectoryReference } from '../protocol/contracts.ts'
import { isDirectoryReference } from '../protocol/validation.ts'
import { isOpaqueId } from '../protocol/protocol.ts'
import { isArrayOf } from '../validation/data-validation.ts'
import { OperationFailure } from '../result.ts'

/** 一个本机游戏：目录引用和对端关联。 */
export interface LibraryGame {
  readonly id: string
  readonly name: string
  readonly rootId: string | null
  readonly links: readonly GameLink[]
  readonly excludedDevices?: readonly string[]
}
/** 本机游戏与某台对端设备上游戏的关联。 */
export interface GameLink {
  readonly deviceId: string
  readonly gameId: string
}
/** 已保存的设备。address 是对端的监听地址，对端不监听时为 null；blocked 为 true 时本机不与它连接。 */
export interface SavedDevice {
  readonly id: string
  readonly name: string
  readonly address: string | null
  readonly blocked: boolean
}
/** 本机的游戏库配置：游戏和已保存的设备。 */
export interface LibraryConfig {
  readonly schemaVersion: 1
  readonly games: readonly LibraryGame[]
  readonly devices: readonly SavedDevice[]
}
/** 目录表里的一个游戏；目录引用失效时 root 为 null。 */
export interface CatalogGame {
  readonly id: string
  readonly name: string
  readonly root: DirectoryReference | null
}
/** 目录表里的一条关联：发送方的游戏 ID 和接收方的游戏 ID。 */
export interface CatalogLink {
  readonly localGameId: string
  readonly remoteGameId: string
}
/** 一端的目录表：游戏和与对方的关联。 */
export interface CatalogPush {
  readonly games: readonly CatalogGame[]
  readonly links: readonly CatalogLink[]
}
/** 带发送方设备 ID 和名称的目录表。 */
export interface CatalogHello extends CatalogPush {
  readonly deviceId: string
  readonly name: string
}
/** 交换目录表时对方答复的目录表。 */
export interface CatalogReply {
  readonly games: readonly CatalogGame[]
  readonly links: readonly CatalogLink[]
}
/** 一台已保存的对端设备，以及它的连接状态和游戏。 */
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
/** 校验已保存的设备。 */
export function isSavedDevice(value: unknown): value is SavedDevice {
  return (
    record(value) &&
    isOpaqueId(value.id) &&
    text(value.name) &&
    typeof value.blocked === 'boolean' &&
    (value.address === null || (typeof value.address === 'string' && value.address.length <= 256))
  )
}
/** 校验整份游戏库配置。 */
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
/** 校验目录表。 */
export function isCatalogPush(value: unknown): value is CatalogPush {
  return record(value) && Object.keys(value).length === 2 && catalog(value)
}
/** 校验带设备身份的目录表：每个目录引用都属于发送方设备。 */
export function isCatalogHello(value: unknown): value is CatalogHello {
  return (
    record(value) &&
    Object.keys(value).length === 4 &&
    catalog(value) &&
    isOpaqueId(value.deviceId) &&
    text(value.name) &&
    (value.games as readonly CatalogGame[]).every(
      (item) => item.root === null || item.root.deviceId === value.deviceId,
    )
  )
}
/** 校验答复的目录表。 */
export function isCatalogReply(value: unknown): value is CatalogReply {
  return record(value) && Object.keys(value).length === 2 && catalog(value)
}
/** 校验对端设备及其游戏列表。 */
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
/** 返回没有游戏和设备的游戏库配置。 */
export function emptyLibrary(): LibraryConfig {
  return { schemaVersion: 1, games: [], devices: [] }
}
/** 去掉 HTTP 地址的协议前缀，保留 IP、IPv6 方括号和端口。 */
export function formatConnectionAddress(value: string): string {
  return value.replace(/^http:\/\//i, '')
}

/**
 * 把 IP 和端口规范成 `http://` 开头的地址；也接受完整的 HTTP 地址。
 *
 * @throws OperationFailure 地址带账户、路径或其他协议时抛出，code 为 invalid-request。
 */
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
    throw new OperationFailure(
      'invalid-request',
      'Enter the IP address and port displayed on the PC.',
    )
  }
  return `http://${host.toLowerCase()}${port ? `:${Number(port)}` : ''}`
}
/** 从本机游戏和目录引用生成目录表的游戏列表；找不到目录引用的游戏 root 为 null。 */
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
/** 列出本机游戏与指定设备的关联。 */
export function libraryLinks(config: LibraryConfig, deviceId: string): readonly CatalogLink[] {
  return config.games.flatMap((item) =>
    item.links
      .filter((link) => link.deviceId === deviceId)
      .map((link) => ({ localGameId: item.id, remoteGameId: link.gameId })),
  )
}
/**
 * 按对端目录表同步本机游戏与该设备的关联。
 *
 * 对端关联到本机游戏的，加入关联，排除列表里有该设备的游戏除外；本机记录的对端游戏已改为关联本机其他游戏的，移除旧关联。
 *
 * @returns 新的游戏库配置，config 本身不变。
 */
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
