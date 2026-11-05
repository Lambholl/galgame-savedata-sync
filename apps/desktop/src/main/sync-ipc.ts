import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { BATCH_LIMITS, isOpaqueId } from '@savedata-sync/shared'
import { SYNC_CHANNELS } from '../bridge/sync-bridge.ts'
import type { WindowsHttpService } from './http-service.ts'
import type { InterruptedWriteStore } from './interrupted-writes.ts'
import type { WindowsRestoreRegistry } from './restore-registry.ts'
import { HttpOperationError, toHttpError } from './http-errors.ts'

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
        key !== 'shouldDeleteExtras' &&
        !isOpaqueId(data[key]),
    )
  ) {
    throw new HttpOperationError('invalid-request', 'The sync reference is invalid.')
  }
  if (
    fields.includes('direction') &&
    data.direction !== 'android-to-windows' &&
    data.direction !== 'windows-to-android'
  ) {
    throw new HttpOperationError('invalid-request', 'The copy direction is invalid.')
  }
  return data
}

/** 注册复制相关 IPC：校验窗口、主 frame、参数和响应大小；跨端发起只登记请求，由移动端执行。 */
export function registerSyncIpc(
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>,
  service: WindowsHttpService,
  restores: WindowsRestoreRegistry,
  interruptedWrites: InterruptedWriteStore,
  isTrusted: (event: IpcMainInvokeEvent) => boolean,
): () => void {
  let isMutating = false
  for (const [action, channel] of Object.entries(SYNC_CHANNELS)) {
    ipc.handle(channel, async (event, ...args: unknown[]) => {
      let hasMutation = false
      try {
        if (!isTrusted(event)) {
          throw new HttpOperationError('permission-denied', 'This page cannot access sync tasks.')
        }
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
              ? service.syncCopies()
              : action === 'restores'
                ? restores.summaries()
                : action === 'remoteRequest'
                  ? service.remoteSyncRequest()
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
          value = service.startRemoteSync(
            data.projectId as string,
            data.peerId as string,
            data.direction as 'android-to-windows' | 'windows-to-android',
          )
        } else if (action === 'confirmRemote') {
          const data = input(args, ['requestId', 'shouldDeleteExtras'])
          if (typeof data.shouldDeleteExtras !== 'boolean') {
            throw new HttpOperationError('invalid-request', 'The confirmation format is invalid.')
          }
          value = service.confirmRemoteSync(data.requestId as string, data.shouldDeleteExtras)
        } else if (action === 'remotePlan' || action === 'cancelRemote') {
          const id = input(args, ['requestId']).requestId as string
          value =
            action === 'remotePlan' ? service.remoteSyncPlan(id) : service.cancelRemoteSync(id)
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
          action === 'copyManifest' ||
          action === 'cancelCopy' ||
          action === 'cleanupCopy'
        ) {
          const data = input(args, ['jobId']),
            id = data.jobId as string
          if (action === 'copyPlan') {
            value = service.syncCopyRequest(id)
          } else if (action === 'copyState') {
            value = service.syncCopyState(id)
          } else if (action === 'copyManifest') {
            value = service.syncCopyManifest(id)
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
