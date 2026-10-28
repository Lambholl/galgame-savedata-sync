import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { BATCH_LIMITS, isOpaqueId } from '@savedata-sync/shared'
import { SYNC_CHANNELS } from '../bridge/sync-bridge.ts'
import type { WindowsHttpService } from './http-service.ts'
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
    throw new HttpOperationError('invalid-request', '同步参数无效。')
  }
  const data = value as Record<string, unknown>
  if (fields.some((key) => key !== 'plan' && !isOpaqueId(data[key]))) {
    throw new HttpOperationError('invalid-request', '同步引用无效。')
  }
  return data
}

/** 固定本机通道：验证窗口/主 frame、封闭参数与响应预算；不接收路径或跨端发起请求。 */
export function registerSyncIpc(
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>,
  service: WindowsHttpService,
  restores: WindowsRestoreRegistry,
  isTrusted: (event: IpcMainInvokeEvent) => boolean,
): () => void {
  let isMutating = false
  for (const [action, channel] of Object.entries(SYNC_CHANNELS)) {
    ipc.handle(channel, async (event, ...args: unknown[]) => {
      let hasMutation = false
      try {
        if (!isTrusted(event)) {
          throw new HttpOperationError('permission-denied', '此页面无法访问同步任务。')
        }
        const isMutation = [
          'cancelCopy',
          'cleanupCopy',
          'prepareRestore',
          'executeRestore',
          'cancelRestore',
          'cleanupRestore',
          'releaseRestore',
        ].includes(action)
        if (isMutation) {
          if (isMutating) {
            throw new HttpOperationError('busy', '上一项同步操作尚未结束。')
          }
          isMutating = true
          hasMutation = true
        }
        let value: unknown
        if (action === 'copies' || action === 'restores' || action === 'activity') {
          if (args.length) {
            throw new HttpOperationError('invalid-request', '任务列表参数无效。')
          }
          value =
            action === 'copies'
              ? service.syncCopies()
              : action === 'restores'
                ? restores.summaries()
                : service.hasWork()
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
            throw new HttpOperationError('invalid-request', '确认计划格式无效。')
          }
          if (serialized === undefined) {
            throw new HttpOperationError('invalid-request', '确认计划格式无效。')
          }
          if (Buffer.byteLength(serialized) > BATCH_LIMITS.maxJsonBytes) {
            throw new HttpOperationError('resource-limit', '确认计划超过限制。')
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
            value = service.cancelSyncCopy(id)
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
            throw new HttpOperationError('invalid-request', '同步操作无效。')
          }
        }
        const result = { status: 'success', value }
        if (Buffer.byteLength(JSON.stringify(result)) > BATCH_LIMITS.maxJsonBytes) {
          throw new HttpOperationError('resource-limit', '同步响应超过限制，请分别读取计划和结果。')
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
