import { BATCH_LIMITS, isOpaqueId } from '@savedata-sync/shared'
import { SYNC_CHANNELS } from '../bridge/sync-bridge.ts'
import type { DesktopRemoteRequest } from '../bridge/sync-bridge.ts'
import type { DesktopDialerSync } from './dialer-sync.ts'
import type { DesktopHttpService } from './http-service.ts'
import type { InterruptedWriteStore } from './interrupted-writes.ts'
import type { DesktopRestoreRegistry } from './restore-registry.ts'
import { HttpOperationError, toHttpError } from './http-errors.ts'
import type { ChannelRegistry } from './channel-registry.ts'

function input(args: readonly unknown[], fields: readonly string[]): Record<string, unknown> {
  const value = args[0]
  if (
    args.length !== 1 ||
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== fields.length ||
    fields.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new HttpOperationError('invalid-request', 'Sync parameters are invalid.')
  }
  const data = value as Record<string, unknown>
  if (
    fields.some(
      (key) =>
        key !== 'plan' &&
        key !== 'direction' &&
        key !== 'shouldBackup' &&
        key !== 'shouldDeleteExtras' &&
        !isOpaqueId(data[key]),
    )
  ) {
    throw new HttpOperationError('invalid-request', 'The sync reference is invalid.')
  }
  if (
    fields.includes('direction') &&
    data.direction !== 'dialer-to-listener' &&
    data.direction !== 'listener-to-dialer'
  ) {
    throw new HttpOperationError('invalid-request', 'The copy direction is invalid.')
  }
  return data
}

/** 两部分各自的最近一次发起请求中更新的那个；都没有时为 null。 */
function latestRequest(
  listener: DesktopRemoteRequest | null,
  dialer: DesktopRemoteRequest | null,
): DesktopRemoteRequest | null {
  if (!listener || !dialer) {
    return listener ?? dialer
  }
  return dialer.updatedAt >= listener.updatedAt ? dialer : listener
}

/**
 * 注册复制接口的通道处理函数；参数无效或响应超限时返回错误结果。
 * 复制任务和发起的请求合并本机作为监听方和拨号方的两部分。
 *
 * @returns 移除这些处理函数的函数。
 */
export function registerSyncIpc(
  ipc: ChannelRegistry,
  service: DesktopHttpService,
  dialerSync: DesktopDialerSync,
  restores: DesktopRestoreRegistry,
  interruptedWrites: InterruptedWriteStore,
): () => void {
  let isMutating = false
  for (const [action, channel] of Object.entries(SYNC_CHANNELS)) {
    ipc.handle(channel, async (...args: unknown[]) => {
      let hasMutation = false
      try {
        const isMutation = [
          'cancelCopy',
          'cleanupCopy',
          'prepareRestore',
          'executeRestore',
          'cancelRestore',
          'cleanupRestore',
          'releaseRestore',
          'startRemote',
          'confirmRemote',
          'cancelRemote',
        ].includes(action)
        if (isMutation) {
          if (isMutating) {
            throw new HttpOperationError('busy', 'The previous sync operation has not finished.')
          }
          isMutating = true
          hasMutation = true
        }
        let value: unknown
        if (
          action === 'copies' ||
          action === 'restores' ||
          action === 'activity' ||
          action === 'remoteRequest'
        ) {
          if (args.length) {
            throw new HttpOperationError('invalid-request', 'Task list parameters are invalid.')
          }
          value =
            action === 'copies'
              ? // 两部分各自按登记顺序排列；合并后按更新时间排，最后一项是最近的传输。
                [...service.syncCopies(), ...dialerSync.summaries()].sort(
                  (a, b) => a.updatedAt - b.updatedAt,
                )
              : action === 'restores'
                ? restores.summaries()
                : action === 'remoteRequest'
                  ? latestRequest(service.remoteSyncRequest(), dialerSync.currentRequest())
                  : service.hasWork()
        } else if (action === 'interruptedWrites') {
          if (args.length) {
            throw new HttpOperationError('invalid-request', 'Task list parameters are invalid.')
          }
          value = await interruptedWrites.list()
        } else if (action === 'dismissInterruptedWrite') {
          await interruptedWrites.dismiss(input(args, ['id']).id as string)
          value = null
        } else if (action === 'startRemote') {
          const data = input(args, ['projectId', 'peerId', 'direction'])
          const projectId = data.projectId as string,
            peerId = data.peerId as string,
            direction = data.direction as 'dialer-to-listener' | 'listener-to-dialer'
          // 同一台设备只有一条连接：本机拨号连着它时本机是拨号方，否则它拨号连着本机。
          value = dialerSync.isPeer(peerId)
            ? dialerSync.start(projectId, peerId, direction)
            : service.startRemoteSync(projectId, peerId, direction)
        } else if (action === 'confirmRemote') {
          const data = input(args, ['requestId', 'shouldBackup', 'shouldDeleteExtras'])
          if (
            typeof data.shouldBackup !== 'boolean' ||
            typeof data.shouldDeleteExtras !== 'boolean'
          ) {
            throw new HttpOperationError('invalid-request', 'The confirmation format is invalid.')
          }
          const id = data.requestId as string
          const choices = {
            shouldBackup: data.shouldBackup,
            shouldDeleteExtras: data.shouldDeleteExtras,
          }
          value = dialerSync.ownsRequest(id)
            ? dialerSync.confirm(id, choices)
            : service.confirmRemoteSync(id, choices)
        } else if (action === 'remotePlan' || action === 'cancelRemote') {
          const id = input(args, ['requestId']).requestId as string
          if (dialerSync.ownsRequest(id)) {
            value = action === 'remotePlan' ? dialerSync.plan(id) : dialerSync.cancel(id)
          } else {
            value =
              action === 'remotePlan' ? service.remoteSyncPlan(id) : service.cancelRemoteSync(id)
          }
        } else if (action === 'prepareRestore') {
          const data = input(args, ['projectId', 'rootId', 'backupId'])
          value = restores.prepare(
            data.projectId as string,
            data.rootId as string,
            data.backupId as string,
          )
        } else if (action === 'executeRestore') {
          const data = input(args, ['restoreId', 'plan'])
          let serialized: string | undefined
          try {
            serialized = JSON.stringify(data.plan)
          } catch {
            throw new HttpOperationError('invalid-request', 'The confirmed plan format is invalid.')
          }
          if (serialized === undefined) {
            throw new HttpOperationError('invalid-request', 'The confirmed plan format is invalid.')
          }
          if (Buffer.byteLength(serialized) > BATCH_LIMITS.maxJsonBytes) {
            throw new HttpOperationError('resource-limit', 'The confirmed plan exceeds the limit.')
          }
          value = restores.execute(data.restoreId as string, data.plan)
        } else if (
          action === 'copyPlan' ||
          action === 'copyState' ||
          action === 'cancelCopy' ||
          action === 'cleanupCopy'
        ) {
          const data = input(args, ['jobId']),
            id = data.jobId as string
          if (dialerSync.has(id)) {
            if (action === 'copyPlan') {
              value = dialerSync.jobRequest(id)
            } else if (action === 'copyState') {
              value = dialerSync.jobState(id)
            } else if (action === 'cancelCopy') {
              value = await dialerSync.cancelJob(id)
            } else {
              await dialerSync.cleanupJob(id)
              value = null
            }
          } else if (action === 'copyPlan') {
            value = service.syncCopyRequest(id)
          } else if (action === 'copyState') {
            value = service.syncCopyState(id)
          } else if (action === 'cancelCopy') {
            value = await service.cancelSyncCopy(id)
          } else {
            await service.cleanupSyncCopy(id)
            value = null
          }
        } else {
          const data = input(args, ['restoreId']),
            id = data.restoreId as string
          if (action === 'restorePlan') {
            value = restores.preview(id)
          } else if (action === 'restoreState') {
            value = restores.state(id)
          } else if (action === 'cancelRestore') {
            value = await restores.cancel(id)
          } else if (action === 'cleanupRestore') {
            value = await restores.retryCleanup(id)
          } else if (action === 'releaseRestore') {
            await restores.release(id)
            value = null
          } else {
            throw new HttpOperationError('invalid-request', 'The sync operation is invalid.')
          }
        }
        const result = { status: 'success', value }
        if (Buffer.byteLength(JSON.stringify(result)) > BATCH_LIMITS.maxJsonBytes) {
          throw new HttpOperationError(
            'resource-limit',
            'The sync response exceeds the limit. Read the plan and result separately.',
          )
        }
        return result
      } catch (cause) {
        return { status: 'error', error: toHttpError(cause).operationError }
      } finally {
        if (hasMutation) {
          isMutating = false
        }
      }
    })
  }
  return () => {
    for (const channel of Object.values(SYNC_CHANNELS)) {
      ipc.removeHandler(channel)
    }
  }
}
