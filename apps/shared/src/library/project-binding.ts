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

/** 一次任务使用的项目、设备和目录绑定，只含稳定 ID。 */
export interface SyncProjectBinding {
  readonly projectId: string
  readonly remoteProjectId: string
  readonly localDeviceId: string
  readonly remoteDeviceId: string
  readonly localRootId: string
  readonly remoteRootId: string
}
/** 校验项目绑定的字段。 */
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
 * 按关联记录，从本机配置和对端目录表确定一次任务的项目绑定。
 *
 * @returns 授权失效、设备离线或目录错位时返回对应的错误。
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
    return fail('invalid-request', 'Project or device directory data is invalid.')
  }
  const game = config.games.find((item) => item.id === projectId)
  const device = config.devices.find((item) => item.id === peer.device.id)
  const link = game?.links.find((item) => item.deviceId === peer.device.id)
  if (!game || !device || !link) {
    return fail(
      'not-found',
      'The project is not linked to this device. Select the project and device again.',
    )
  }
  if (!peer.isConnected || device.blocked) {
    return fail('network-failure', 'Connect to the device linked to the project first.')
  }
  const localRoot = roots.find((item) => item.rootId === game.rootId)
  const remoteGame = peer.games.find((item) => item.id === link.gameId)
  const remoteRoot = remoteGame?.root
  if (!localRoot || !remoteRoot) {
    return fail('not-found', 'The project directory changed. Reopen Game settings.')
  }
  if (localRoot.authorization !== 'granted' || remoteRoot.authorization !== 'granted') {
    return fail(
      'authorization-expired',
      'Save directory permission expired. Select the directory again.',
    )
  }
  if (remoteRoot.deviceId !== peer.device.id || localRoot.deviceId === peer.device.id) {
    return fail('session-mismatch', 'The directory belongs to another device. Link it again.')
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

/** 判断已确认的绑定是否仍与当前配置和目录表一致；只比较 ID。 */
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
