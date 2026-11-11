import type { CatalogGame, LibraryGame } from './library.ts'

/**
 * 追加一条对端游戏关联，并把该设备移出排除列表。
 *
 * @param game 不能已经有该设备的关联。
 * @returns 新的游戏配置，game 本身不变。
 */
export function withGameLink(game: LibraryGame, deviceId: string, gameId: string): LibraryGame {
  return {
    ...game,
    links: [...game.links, { deviceId, gameId }],
    excludedDevices: (game.excludedDevices ?? []).filter((id) => id !== deviceId),
  }
}

/**
 * 解除与该设备的关联，并把设备加入排除列表，使对端的关联不再合并进来。
 *
 * @returns 新的游戏配置，game 本身不变。
 */
export function withoutGameLink(game: LibraryGame, deviceId: string): LibraryGame {
  return {
    ...game,
    links: game.links.filter((item) => item.deviceId !== deviceId),
    excludedDevices: [...(game.excludedDevices ?? []), deviceId],
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
