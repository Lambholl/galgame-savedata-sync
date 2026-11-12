import {
  matchesSyncProjectBinding,
  observeSyncJob,
  OperationFailure,
  resolveSyncProjectBinding,
  syncPlanFromPreview,
  unwrap,
} from '@savedata-sync/shared'
import type {
  DirectoryReference,
  InterruptedWrite,
  OperationResult,
  SyncBackupPolicy,
  SyncBackupSettings,
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

/** 一次复制任务的状态、预览和计划。 */
export interface MobileCopyDetails {
  readonly state: SyncTransferState
  readonly preview: SyncPreparationPreview
  readonly plan: SyncPlan
}
/** 一次恢复任务的状态和计划；计划还没生成时为 null。 */
export interface MobileRestoreDetails {
  readonly state: AndroidRestoreState
  readonly plan: SyncPlan | null
}
/** 一个游戏当前目录的备份信息和备份列表。 */
export interface MobileBackupDetails {
  readonly info: AndroidBackupInfo
  readonly listing: AndroidBackupList
  readonly root: DirectoryReference
}
/** 移动复制接口：复制、备份和恢复。所有方法失败时 reject。 */
export interface MobileSyncAdapter {
  /** 核对项目关联后开始扫描两端，准备一次复制。 */
  prepare(
    projectId: string,
    deviceId: string,
    direction: TransferDirection,
  ): Promise<SyncPreparationState>
  /** 读取准备的状态。 */
  preparation(id: string): Promise<SyncPreparationState>
  /** 读取准备好的预览。 */
  preview(id: string): Promise<SyncPreparationPreview>
  /** 取消准备。 */
  cancelPreparation(id: string): Promise<SyncPreparationState>
  /** 释放准备。 */
  releasePreparation(id: string): Promise<void>
  /** 核对项目关联、申请通知权限后执行；计划按原预览和 shouldDeleteExtras 重新生成，准备已过期时 reject plan-expired。 */
  execute(id: string, shouldDeleteExtras: boolean): Promise<SyncTransferState>
  /** 读取当前复制任务；没有时为 null。shouldRefresh 为 true 时先向对方查询。 */
  currentCopy(shouldRefresh?: boolean): Promise<MobileCopyDetails | null>
  /** 这款游戏最近一次任务；进程内没有记录时返回 null。 */
  latestCopy(projectId: string, shouldRefresh?: boolean): Promise<MobileCopyDetails | null>
  /** 取消复制任务。 */
  cancelCopy(id: string): Promise<void>
  /** 重试复制任务的缓存清理。 */
  cleanupCopy(): Promise<void>
  /** 读取这个游戏当前目录的备份。 */
  backups(projectId: string): Promise<MobileBackupDetails>
  /** 读取全局与各游戏的备份设置，不需要游戏目录。 */
  backupSettings(): Promise<SyncBackupSettings>
  /** 单独设置这个游戏当前目录的备份；null 改回跟随全局。 */
  setBackup(projectId: string, policy: SyncBackupPolicy | null): Promise<void>
  /** 修改全局备份设置。 */
  setBackupDefaults(policy: SyncBackupPolicy): Promise<void>
  /** 按保留份数删除这个游戏当前目录多余的旧备份。 */
  rotateBackups(projectId: string): Promise<void>
  /** 删除一份残留备份。 */
  cleanupBackup(projectId: string, backupId: string): Promise<void>
  /** 删除一份已提交的备份。 */
  deleteBackup(projectId: string, backupId: string): Promise<void>
  /** 删除一个游戏的全部备份和单独设置，不需要游戏目录。 */
  deleteGameBackups(projectId: string): Promise<void>
  /** 从一份备份创建恢复任务并生成恢复计划。 */
  prepareRestore(projectId: string, backupId: string): Promise<AndroidRestoreState>
  /** 读取当前恢复任务；没有时为 null。 */
  currentRestore(): Promise<MobileRestoreDetails | null>
  /** 按恢复计划执行恢复。 */
  executeRestore(id: string): Promise<AndroidRestoreState>
  /** 取消恢复任务。 */
  cancelRestore(id: string): Promise<void>
  /** 释放已结束或还没开始的恢复任务。 */
  releaseRestore(id: string): Promise<void>
  /** 重试恢复任务的缓存清理。 */
  cleanupRestore(): Promise<void>
  /** 列出之前的进程没写完就结束时留下的写入标记。 */
  interruptedWrites(): Promise<readonly InterruptedWrite[]>
  /** 删除一个写入标记。 */
  dismissInterruptedWrite(id: string): Promise<void>
}
/** 移动复制适配器的依赖。 */
export interface MobileSyncDependencies {
  readonly copies: AndroidSyncTransferApi
  readonly writes: AndroidSyncWriteApi
  readonly backups: AndroidBackupApi
  readonly requestNotifications: () => Promise<boolean>
}

function copyHasWork(state: SyncTransferState): boolean {
  return (
    observeSyncJob(state.local, state.remote, state.remoteError !== null).phase === 'running' ||
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

/** 判断是否有进行中的复制或恢复任务。 */
export async function hasAndroidSyncWork(): Promise<boolean> {
  const copyId = unwrap(await androidSyncTransfers.current())
  if (copyId && copyHasWork(unwrap(await androidSyncTransfers.query(copyId)))) {
    return true
  }
  const restoreId = unwrap(await androidSyncWrites.current())
  return restoreId !== null && restoreHasWork(unwrap(await androidSyncWrites.query(restoreId)))
}

/** 创建移动复制适配器。 */
export function createMobileSyncAdapter(
  library: MobileLibraryAdapter,
  dependencies?: Partial<MobileSyncDependencies>,
): MobileSyncAdapter {
  const copies = dependencies?.copies ?? androidSyncTransfers
  const writes = dependencies?.writes ?? androidSyncWrites
  const backups = dependencies?.backups ?? androidBackups
  async function copyDetails(
    id: string | null,
    shouldRefresh: boolean,
  ): Promise<MobileCopyDetails | null> {
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
  }
  async function local(projectId: string): Promise<DirectoryReference> {
    const snapshot = await library.read()
    const game = snapshot.config.games.find((item) => item.id === projectId)
    const root = snapshot.roots.find((item) => item.rootId === game?.rootId)
    if (!root || root.authorization !== 'granted') {
      throw new OperationFailure(
        'authorization-expired',
        'Save directory permission expired. Select the directory again in Game settings.',
      )
    }
    return root
  }
  /** 取出结果的值；准备已过保留时间、原生层查不到时抛出 plan-expired。 */
  function unlessExpired<T>(result: OperationResult<T>): T {
    if (result.status === 'error' && result.error.code === 'not-found') {
      throw new OperationFailure('plan-expired', 'The comparison expired. Scan again.')
    }
    return unwrap(result)
  }
  async function binding(projectId: string, deviceId: string) {
    const snapshot = await library.read()
    const peer = snapshot.peers.find((item) => item.device.id === deviceId)
    if (!peer) {
      throw new OperationFailure('session-mismatch', 'Connect to the device linked to this game.')
    }
    return unwrap(resolveSyncProjectBinding(snapshot.config, snapshot.roots, peer, projectId))
  }
  // 连发时后发的调用可能先到原生层（核对绑定是异步的，插件还用线程池），而原生层让后到的取代先到的，这里保证按发起顺序到达。
  let lastPrepare: Promise<unknown> = Promise.resolve()
  return {
    async prepare(projectId, deviceId, direction) {
      const start = async (): Promise<SyncPreparationState> =>
        unwrap(await copies.prepare(await binding(projectId, deviceId), direction))
      const result = lastPrepare.then(start, start)
      lastPrepare = result
      return result
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
    async execute(id, shouldDeleteExtras) {
      const preview = unlessExpired(await copies.preview(id))
      const expected = preview.binding
      const isPermitted = dependencies?.requestNotifications
        ? await dependencies.requestNotifications()
        : unwrap(await androidTransfers.requestNotifications())
      if (!isPermitted) {
        throw new OperationFailure('permission-denied', 'Allow transfer notifications and retry.')
      }
      if (
        !matchesSyncProjectBinding(
          expected,
          await binding(expected.projectId, expected.remoteDeviceId),
        )
      ) {
        throw new OperationFailure(
          'task-conflict',
          'The project or directory link changed. Scan and confirm again.',
        )
      }
      return unlessExpired(
        await copies.execute(id, syncPlanFromPreview({ ...preview, shouldDeleteExtras })),
      )
    },
    async currentCopy(shouldRefresh = false) {
      return copyDetails(unwrap(await copies.current()), shouldRefresh)
    },
    async latestCopy(projectId, shouldRefresh = false) {
      return copyDetails(unwrap(await copies.latest(projectId)), shouldRefresh)
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
        listing: unwrap(await backups.list(projectId)),
      }
    },
    async backupSettings() {
      return unwrap(await backups.read()).settings
    },
    async setBackup(projectId, policy) {
      // 单独设置只按游戏保存，但游戏要先在本机选好目录。
      await local(projectId)
      unwrap(await backups.setPreference(projectId, policy))
    },
    async setBackupDefaults(policy) {
      unwrap(await backups.setDefaults(policy))
    },
    async rotateBackups(projectId) {
      unwrap(await backups.rotate(projectId))
    },
    async cleanupBackup(projectId, backupId) {
      unwrap(await backups.cleanupIncomplete(projectId, backupId))
    },
    async deleteBackup(projectId, backupId) {
      unwrap(await backups.deleteBackup(projectId, backupId))
    },
    async deleteGameBackups(projectId) {
      unwrap(await backups.deleteGameBackups(projectId))
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
        throw new OperationFailure(
          'task-conflict',
          'The project directory changed. Preview the backup again.',
        )
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
    async interruptedWrites() {
      return unwrap(await writes.interruptedWrites())
    },
    async dismissInterruptedWrite(id) {
      unwrap(await writes.dismissInterruptedWrite(id))
    },
  }
}
