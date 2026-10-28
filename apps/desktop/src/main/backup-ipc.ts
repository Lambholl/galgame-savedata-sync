import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { BATCH_LIMITS, isOpaqueId } from '@savedata-sync/shared'
import { BACKUP_CHANNELS } from '../bridge/backup-bridge.ts'
import type { WindowsBackupStore } from './backup-store.ts'
import type { DesktopLibrary } from './library-store.ts'
import { HttpOperationError, toHttpError } from './http-errors.ts'
import { hasTargetOperation } from './target-operation.ts'

/** 本机备份摘要/设置/显式残留清理，验证主窗口来源；恢复写入另由恢复模块提供。 */
export function registerBackupIpc(
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>,
  store: WindowsBackupStore,
  library: DesktopLibrary,
  isTrusted: (event: IpcMainInvokeEvent) => boolean,
  hasRunningWork: () => boolean = () => false,
): () => void {
  for (const [action, channel] of Object.entries(BACKUP_CHANNELS)) {
    ipc.handle(channel, async (event, ...args: unknown[]) => {
      try {
        if (!isTrusted(event)) {
          throw new HttpOperationError('permission-denied', '此页面无法访问备份。')
        }
        let value: unknown
        if (action === 'read') {
          if (args.length) {
            throw new HttpOperationError('invalid-request', '备份读取参数无效。')
          }
          value = { displayPath: store.path, settings: await store.settings() }
        } else {
          const input = args[0]
          const fields = [
            'projectId',
            'rootId',
            ...(action === 'manifest' || action === 'cleanupIncomplete' ? ['backupId'] : []),
            ...(action === 'setPreference' ? ['shouldBackup'] : []),
          ]
          if (
            args.length !== 1 ||
            typeof input !== 'object' ||
            input === null ||
            Array.isArray(input) ||
            Object.keys(input).length !== fields.length ||
            fields.some((field) => !Object.hasOwn(input, field))
          ) {
            throw new HttpOperationError('invalid-request', '备份参数无效。')
          }
          const data = input as Record<string, unknown>
          if (
            !isOpaqueId(data.projectId) ||
            !isOpaqueId(data.rootId) ||
            (fields.includes('backupId') && !isOpaqueId(data.backupId))
          ) {
            throw new HttpOperationError('invalid-request', '备份引用无效。')
          }
          if (
            (action === 'setPreference' && hasTargetOperation()) ||
            ((action === 'rotate' || action === 'cleanupIncomplete') && hasRunningWork())
          ) {
            throw new HttpOperationError('busy', '请等当前文件操作结束后再修改备份设置或清理备份。')
          }
          if (action === 'setPreference') {
            if (
              typeof data.shouldBackup !== 'boolean' ||
              !library
                .snapshot()
                .config.games.some(
                  (game) => game.id === data.projectId && game.rootId === data.rootId,
                )
            ) {
              throw new HttpOperationError('invalid-request', '请先配置该游戏的本机目录。')
            }
            value = await store.setPreference(data.projectId, data.rootId, data.shouldBackup)
          } else if (action === 'rotate') {
            await store.rotate(data.projectId, data.rootId)
            value = null
          } else if (action === 'cleanupIncomplete') {
            await store.cleanupIncomplete(data.projectId, data.rootId, data.backupId as string)
            value = null
          } else {
            const listing = await store.list(data.projectId, data.rootId)
            if (action === 'manifest') {
              const manifest = listing.backups.find((item) => item.backupId === data.backupId)
              if (!manifest) {
                throw new HttpOperationError('not-found', '备份不存在或归属不符。')
              }
              value = manifest
            } else {
              value = {
                incomplete: listing.incomplete,
                backups: listing.backups.map((item) => ({
                  backupId: item.backupId,
                  projectId: item.projectId,
                  rootId: item.rootId,
                  createdAt: item.createdAt,
                  reason: item.reason,
                  fileCount: item.files.length,
                  totalFileBytes: item.files.reduce((total, file) => total + file.sizeBytes, 0),
                })),
              }
            }
          }
        }
        if (Buffer.byteLength(JSON.stringify(value)) > BATCH_LIMITS.maxJsonBytes) {
          throw new HttpOperationError('resource-limit', '备份响应超过限制。')
        }
        return { status: 'success', value }
      } catch (error) {
        return { status: 'error', error: toHttpError(error).operationError }
      }
    })
  }
  return () => {
    for (const channel of Object.values(BACKUP_CHANNELS)) {
      ipc.removeHandler(channel)
    }
  }
}
