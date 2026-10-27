import type { CatalogGame, LibraryGame } from './library.ts'

/** 追加已选的对端游戏关联并恢复该设备的反向合并；调用端应先筛除已有的关联设备。 */
export function withGameLink(game: LibraryGame, deviceId: string, gameId: string): LibraryGame {
  return {
    ...game,
    links: [...game.links, { deviceId, gameId }],
    excludedDevices: (game.excludedDevices ?? []).filter((id) => id !== deviceId),
  }
}

/** 解除该设备的关联，并记录排除项以阻止对端自动恢复；返回新配置，由调用端保存。 */
export function withoutGameLink(game: LibraryGame, deviceId: string): LibraryGame {
  return {
    ...game,
    links: game.links.filter((item) => item.deviceId !== deviceId),
    excludedDevices: [...(game.excludedDevices ?? []), deviceId],
  }
}

/** 用调用端生成的 ID 导入对端游戏名称与关联；本机目录留空，由调用端选择并保存。 */
export function createImportedGame(id: string, game: CatalogGame, deviceId: string): LibraryGame {
  return {
    id,
    name: game.name,
    rootId: null,
    links: [{ deviceId, gameId: game.id }],
  }
}
