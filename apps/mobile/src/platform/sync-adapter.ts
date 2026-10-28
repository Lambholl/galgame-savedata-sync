import {
  matchesSyncProjectBinding,
  resolveSyncProjectBinding,
  syncPlanFromPreview,
  unwrap,
} from '@savedata-sync/shared'
import type {
  DirectoryReference,
  SyncPlan,
  SyncPreparationPreview,
  SyncPreparationState,
  SyncTransferState,
  TransferDirection,
} from '@savedata-sync/shared'
import { androidSyncTransfers } from './sync-transfers'
import { androidSyncWrites } from './sync-writes'
import { androidBackups } from './backups'
import { androidTransfers } from './http-transfers'
import type { AndroidSyncTransferApi } from './sync-transfer-bridge'
import type { AndroidRestoreState, AndroidSyncWriteApi } from './sync-write-bridge'
import type { AndroidBackupApi, AndroidBackupInfo, AndroidBackupList } from './backup-bridge'
import type { MobileLibraryAdapter } from './library-types'

/** 页面展示的固定原生任务上下文；重新读取只查询原任务，不启动或重放执行。 */
export interface MobileCopyDetails {
  readonly state: SyncTransferState
  readonly preview: SyncPreparationPreview
  readonly plan: SyncPlan
}
export interface MobileRestoreDetails {
  readonly state: AndroidRestoreState
  readonly plan: SyncPlan | null
}
export interface MobileBackupDetails {
  readonly info: AndroidBackupInfo
  readonly listing: AndroidBackupList
  readonly root: DirectoryReference
}
/** 失败抛 Error；执行前重新核对已保存项目、根、设备关联，通知权限仅在实际传输前请求。 */
export interface MobileSyncAdapter {
  prepare(
    projectId: string,
    deviceId: string,
    direction: TransferDirection,
  ): Promise<SyncPreparationState>
  preparation(id: string): Promise<SyncPreparationState>
  preview(id: string): Promise<SyncPreparationPreview>
  cancelPreparation(id: string): Promise<SyncPreparationState>
  releasePreparation(id: string): Promise<void>
  execute(id: string): Promise<SyncTransferState>
  currentCopy(shouldRefresh?: boolean): Promise<MobileCopyDetails | null>
  cancelCopy(id: string): Promise<void>
  cleanupCopy(): Promise<void>
  backups(projectId: string): Promise<MobileBackupDetails>
  setBackup(projectId: string, shouldBackup: boolean): Promise<void>
  rotateBackups(projectId: string): Promise<void>
  cleanupBackup(projectId: string, backupId: string): Promise<void>
  prepareRestore(projectId: string, backupId: string): Promise<AndroidRestoreState>
  currentRestore(): Promise<MobileRestoreDetails | null>
  executeRestore(id: string): Promise<AndroidRestoreState>
  cancelRestore(id: string): Promise<void>
  releaseRestore(id: string): Promise<void>
  cleanupRestore(): Promise<void>
}
/** 默认使用真实原生桥；替换依赖只用于本包的临时集成验证。 */
export interface MobileSyncDependencies {
  readonly copies: AndroidSyncTransferApi
  readonly writes: AndroidSyncWriteApi
  readonly backups: AndroidBackupApi
  readonly requestNotifications: () => Promise<boolean>
}

function copyHasWork(state: SyncTransferState): boolean {
  return (
    state.local.status === 'running' ||
    state.remote?.status === 'running' ||
    state.local.cleanupError !== null
  )
}
function restoreHasWork(state: AndroidRestoreState): boolean {
  return (
    state.status === 'preparing' ||
    state.status === 'running' ||
    Boolean(state.result?.cleanupError)
  )
}

/** 编辑配置和断开空闲连接前查询原生所有者，不读取前后台状态。 */
export async function hasAndroidSyncWork(): Promise<boolean> {
  const copyId = unwrap(await androidSyncTransfers.current())
  if (copyId && copyHasWork(unwrap(await androidSyncTransfers.query(copyId)))) {
    return true
  }
  const restoreId = unwrap(await androidSyncWrites.current())
  return restoreId !== null && restoreHasWork(unwrap(await androidSyncWrites.query(restoreId)))
}

/** 平台校验持久配置，原生桥校验本次计划和结果；网页不持有文件、路径或写权限。 */
export function createMobileSyncAdapter(
  library: MobileLibraryAdapter,
  dependencies?: Partial<MobileSyncDependencies>,
): MobileSyncAdapter {
  const copies = dependencies?.copies ?? androidSyncTransfers
  const writes = dependencies?.writes ?? androidSyncWrites
  const backups = dependencies?.backups ?? androidBackups
  async function local(projectId: string): Promise<DirectoryReference> {
    const snapshot = await library.read()
    const game = snapshot.config.games.find((item) => item.id === projectId)
    const root = snapshot.roots.find((item) => item.rootId === game?.rootId)
    if (!root || root.authorization !== 'granted') {
      throw new Error('存档目录权限已失效，请到目录设置重新选择。')
    }
    return root
  }
  async function binding(projectId: string, deviceId: string) {
    const snapshot = await library.read()
    const peer = snapshot.peers.find((item) => item.device.id === deviceId)
    if (!peer) {
      throw new Error('请连接这个游戏关联的设备。')
    }
    return unwrap(resolveSyncProjectBinding(snapshot.config, snapshot.roots, peer, projectId))
  }
  return {
    async prepare(projectId, deviceId, direction) {
      return unwrap(await copies.prepare(await binding(projectId, deviceId), direction))
    },
    async preparation(id) {
      return unwrap(await copies.queryPreparation(id))
    },
    async preview(id) {
      return unwrap(await copies.preview(id))
    },
    async cancelPreparation(id) {
      return unwrap(await copies.cancelPreparation(id))
    },
    async releasePreparation(id) {
      unwrap(await copies.release(id))
    },
    async execute(id) {
      const preview = unwrap(await copies.preview(id))
      const expected = preview.binding
      const isPermitted = dependencies?.requestNotifications
        ? await dependencies.requestNotifications()
        : unwrap(await androidTransfers.requestNotifications())
      if (!isPermitted) {
        throw new Error('请允许传输通知后重试。')
      }
      if (
        !matchesSyncProjectBinding(
          expected,
          await binding(expected.projectId, expected.remoteDeviceId),
        )
      ) {
        throw new Error('项目或目录关联已变化，请重新扫描并确认。')
      }
      return unwrap(await copies.execute(id, syncPlanFromPreview(preview)))
    },
    async currentCopy(shouldRefresh = false) {
      const id = unwrap(await copies.current())
      if (!id) {
        return null
      }
      let state = unwrap(await copies.query(id, shouldRefresh))
      // sender 的 sent 只表示发送完毕；目标仍在处理时继续只读查询同一个任务。
      if (
        !shouldRefresh &&
        state.local.status !== 'running' &&
        (state.remote?.status === 'running' ||
          (state.local.status === 'sent' && state.remote === null))
      ) {
        state = unwrap(await copies.query(id, true))
      }
      const preview = unwrap(await copies.preview(id))
      return { state, preview, plan: syncPlanFromPreview(preview) }
    },
    async cancelCopy(id) {
      unwrap(await copies.cancel(id))
    },
    async cleanupCopy() {
      unwrap(await copies.retryCleanup())
    },
    async backups(projectId) {
      const root = await local(projectId)
      return {
        root,
        info: unwrap(await backups.read()),
        listing: unwrap(await backups.list(projectId, root.rootId)),
      }
    },
    async setBackup(projectId, shouldBackup) {
      const root = await local(projectId)
      unwrap(await backups.setPreference(projectId, root.rootId, shouldBackup))
    },
    async rotateBackups(projectId) {
      const root = await local(projectId)
      unwrap(await backups.rotate(projectId, root.rootId))
    },
    async cleanupBackup(projectId, backupId) {
      const root = await local(projectId)
      unwrap(await backups.cleanupIncomplete(projectId, root.rootId, backupId))
    },
    async prepareRestore(projectId, backupId) {
      const root = await local(projectId)
      unwrap(await writes.bindProject(projectId, root.rootId))
      return unwrap(await writes.prepareRestore(projectId, root.rootId, backupId))
    },
    async currentRestore() {
      const id = unwrap(await writes.current())
      if (!id) {
        return null
      }
      const state = unwrap(await writes.query(id))
      const plan =
        state.status === 'ready' || state.status === 'running' || state.result !== null
          ? unwrap(await writes.preview(id))
          : null
      return { state, plan }
    },
    async executeRestore(id) {
      const state = unwrap(await writes.query(id))
      const root = await local(state.projectId)
      if (root.rootId !== state.rootId) {
        throw new Error('项目目录已变化，请重新预览备份。')
      }
      return unwrap(await writes.execute(id, unwrap(await writes.preview(id))))
    },
    async cancelRestore(id) {
      unwrap(await writes.cancel(id))
    },
    async releaseRestore(id) {
      unwrap(await writes.release(id))
    },
    async cleanupRestore() {
      unwrap(await writes.retryCleanup())
    },
  }
}
