import type {
  DirectoryReference,
  OperationErrorCode,
  OperationResult,
} from '../protocol/contracts.ts'
import { isOpaqueId } from '../protocol/protocol.ts'
import { isDirectoryReference } from '../protocol/validation.ts'
import { hasShape, isArrayOf } from '../validation/data-validation.ts'
import type { LibraryConfig, LibraryPeer } from './library.ts'
import { isLibraryConfig, isLibraryPeer } from './library.ts'

/** 本次任务使用的项目/设备/目录绑定；只复制稳定 ID，不保留可变配置对象。 */
export interface SyncProjectBinding {
  readonly projectId: string
  readonly remoteProjectId: string
  readonly localDeviceId: string
  readonly remoteDeviceId: string
  readonly localRootId: string
  readonly remoteRootId: string
}
/** 仅稳定 ID 的封闭绑定；实际配置、授权和连接仍由两端原生层核实。 */
export function isSyncProjectBinding(value: unknown): value is SyncProjectBinding {
  return (
    hasShape(value, [
      'projectId',
      'remoteProjectId',
      'localDeviceId',
      'remoteDeviceId',
      'localRootId',
      'remoteRootId',
    ]) &&
    Object.values(value).every(isOpaqueId) &&
    value.localDeviceId !== value.remoteDeviceId
  )
}

function fail<TValue>(code: OperationErrorCode, message: string): OperationResult<TValue> {
  return code === 'result-unknown' || code === 'session-mismatch'
    ? { status: 'error', error: { code, message, canRetry: false } }
    : { status: 'error', error: { code, message, canRetry: true } }
}

/**
 * 从已登记本机目录和当前对端目录表固定项目映射；不按名称或 IP 猜测关联。
 * 失效授权/离线/错位目录返回具体错误，成功值只含 ID。调用前后由平台刷新真实目录。
 */
export function resolveSyncProjectBinding(
  config: LibraryConfig,
  roots: readonly DirectoryReference[],
  peer: LibraryPeer,
  projectId: string,
): OperationResult<SyncProjectBinding> {
  if (
    !isLibraryConfig(config) ||
    !isArrayOf(roots, isDirectoryReference) ||
    new Set(roots.map((root) => root.rootId)).size !== roots.length ||
    !isLibraryPeer(peer) ||
    !isOpaqueId(projectId)
  ) {
    return fail('invalid-request', '项目或设备目录数据无效。')
  }
  const game = config.games.find((item) => item.id === projectId)
  const device = config.devices.find((item) => item.id === peer.device.id)
  const link = game?.links.find((item) => item.deviceId === peer.device.id)
  if (!game || !device || !link) {
    return fail('not-found', '项目尚未关联这台设备，请重新选择项目和设备。')
  }
  if (!peer.isConnected || device.blocked) {
    return fail('network-failure', '请先连接项目关联的设备。')
  }
  const localRoot = roots.find((item) => item.rootId === game.rootId)
  const remoteGame = peer.games.find((item) => item.id === link.gameId)
  const remoteRoot = remoteGame?.root
  if (!localRoot || !remoteRoot) {
    return fail('not-found', '项目目录已变化，请重新打开目录设置。')
  }
  if (localRoot.authorization !== 'granted' || remoteRoot.authorization !== 'granted') {
    return fail('authorization-expired', '存档目录权限已失效，请重新选择目录。')
  }
  if (remoteRoot.deviceId !== peer.device.id || localRoot.deviceId === peer.device.id) {
    return fail('session-mismatch', '目录属于另一台设备，请重新关联。')
  }
  return {
    status: 'success',
    value: {
      projectId,
      remoteProjectId: link.gameId,
      localDeviceId: localRoot.deviceId,
      remoteDeviceId: peer.device.id,
      localRootId: localRoot.rootId,
      remoteRootId: remoteRoot.rootId,
    },
  }
}

/** 对照新读取的配置/目录表复核已确认绑定；别名或 IP 改动不改变身份关系。 */
export function matchesSyncProjectBinding(
  expected: SyncProjectBinding,
  current: SyncProjectBinding,
): boolean {
  return (
    expected.projectId === current.projectId &&
    expected.remoteProjectId === current.remoteProjectId &&
    expected.localDeviceId === current.localDeviceId &&
    expected.remoteDeviceId === current.remoteDeviceId &&
    expected.localRootId === current.localRootId &&
    expected.remoteRootId === current.remoteRootId
  )
}
