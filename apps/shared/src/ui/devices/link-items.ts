import type { LibraryGame, LibraryPeer } from '../../library/library.ts'
import type { LinkedDevice } from './LinkedDeviceList.tsx'
import type { LinkPickerDevice, LinkPickerGame } from './LinkPicker.tsx'

/** 把游戏的关联记录转成关联设备列表；peerKind 是对端的设备类型。 */
export function linkedDevices(
  game: LibraryGame,
  peers: readonly LibraryPeer[],
  peerKind: LinkedDevice['kind'],
  removedName: string,
): readonly LinkedDevice[] {
  return game.links.map((link) => {
    const peer = peers.find((item) => item.device.id === link.deviceId)
    const remote = peer?.games.find((item) => item.id === link.gameId)
    return {
      deviceId: link.deviceId,
      name: peer?.device.name ?? removedName,
      kind: peerKind,
      isConnected: peer?.isConnected ?? false,
      gameName: remote?.name ?? null,
      path: remote?.root ? (remote.root.displayPath ?? remote.root.displayName) : null,
      isRemoved: !peer,
    }
  })
}

/** 生成关联选择第一步的设备列表，每台设备标出 available、linked 或 offline。 */
export function linkPickerDevices(
  game: LibraryGame,
  peers: readonly LibraryPeer[],
  peerKind: LinkPickerDevice['kind'],
): readonly LinkPickerDevice[] {
  return peers.map((peer) => ({
    deviceId: peer.device.id,
    name: peer.device.name,
    kind: peerKind,
    state: game.links.some((link) => link.deviceId === peer.device.id)
      ? 'linked'
      : peer.isConnected
        ? 'available'
        : 'offline',
  }))
}

/** 生成关联选择第二步的游戏列表：与本机游戏同名的排在前面并标为推荐。 */
export function linkPickerGames(
  game: LibraryGame,
  peer: LibraryPeer | undefined,
): readonly LinkPickerGame[] {
  const key = game.name.trim().toLocaleLowerCase()
  return (peer?.games ?? [])
    .map((item) => ({
      id: item.id,
      name: item.name,
      isRecommended: item.name.trim().toLocaleLowerCase() === key,
    }))
    .sort((a, b) => Number(b.isRecommended) - Number(a.isRecommended))
}
