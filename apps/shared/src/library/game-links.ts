import { LIBRARY_LIMITS } from './library.ts'
import type { CatalogGame, GameLink, LibraryGame, LibraryPeer } from './library.ts'

/**
 * 判断游戏现在能不能打开传输页。
 *
 * @returns no-link：游戏没有关联设备；offline：关联的设备都没有连接；null：至少一台关联设备已连接。
 */
export function gameTransferBlocker(
  game: LibraryGame,
  peers: readonly LibraryPeer[],
): 'no-link' | 'offline' | null {
  if (game.links.length === 0) {
    return 'no-link'
  }
  const isAnyConnected = game.links.some((link) =>
    peers.some((peer) => peer.isConnected && peer.device.id === link.deviceId),
  )
  return isAnyConnected ? null : 'offline'
}

function isSameLink(value: GameLink, deviceId: string, gameId: string): boolean {
  return value.deviceId === deviceId && value.gameId === gameId
}

/**
 * 追加一条对端游戏关联，并把这条关联移出排除列表。
 *
 * @param game 不能已经有该设备的关联。
 * @returns 新的游戏配置，game 本身不变。
 */
export function withGameLink(game: LibraryGame, deviceId: string, gameId: string): LibraryGame {
  return {
    ...game,
    links: [...game.links, { deviceId, gameId }],
    excludedLinks: (game.excludedLinks ?? []).filter((item) => !isSameLink(item, deviceId, gameId)),
  }
}

/**
 * 解除与该设备的关联，并把解除的这条关联加入排除列表，使对端仍报的这条关联不再合并进来；
 * 该设备上别的游戏以后关联过来时照常合并。排除列表超过 LIBRARY_LIMITS.maxDevices 条时丢掉最早的。
 *
 * @returns 新的游戏配置，game 本身不变；没有该设备的关联时只返回副本。
 */
export function withoutGameLink(game: LibraryGame, deviceId: string): LibraryGame {
  const removed = game.links.find((item) => item.deviceId === deviceId)
  if (!removed) {
    return { ...game }
  }
  const excluded = (game.excludedLinks ?? []).filter(
    (item) => !isSameLink(item, deviceId, removed.gameId),
  )
  return {
    ...game,
    links: game.links.filter((item) => item.deviceId !== deviceId),
    excludedLinks: [...excluded, removed].slice(-LIBRARY_LIMITS.maxDevices),
  }
}

/**
 * 按对端游戏创建本机游戏：使用对端的名称并关联对端游戏，本机目录为空。
 *
 * @param id 新游戏的 ID。
 */
export function createImportedGame(id: string, game: CatalogGame, deviceId: string): LibraryGame {
  return {
    id,
    name: game.name,
    rootId: null,
    links: [{ deviceId, gameId: game.id }],
  }
}
