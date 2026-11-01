import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { BATCH_LIMITS, isOpaqueId, isSyncBackupPolicy } from '@savedata-sync/shared'
import type { SyncBackupPolicy } from '@savedata-sync/shared'
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
          throw new HttpOperationError('permission-denied', 'This page cannot access backups.')
        }
        let value: unknown
        if (action === 'read') {
          if (args.length) {
            throw new HttpOperationError('invalid-request', 'Backup read parameters are invalid.')
          }
          value = { displayPath: store.path, settings: await store.settings() }
        } else if (action === 'setDefaults') {
          const input = args[0]
          if (
            args.length !== 1 ||
            typeof input !== 'object' ||
            input === null ||
            Array.isArray(input) ||
            Object.keys(input).length !== 1 ||
            !isSyncBackupPolicy((input as Record<string, unknown>).policy)
          ) {
            throw new HttpOperationError('invalid-request', 'Backup settings are invalid.')
          }
          if (hasTargetOperation()) {
            throw new HttpOperationError(
              'busy',
              'Wait for the current file operation to finish before changing backup settings.',
            )
          }
          value = await store.setDefaults((input as { policy: SyncBackupPolicy }).policy)
        } else {
          const input = args[0]
          const fields = [
            'projectId',
            'rootId',
            ...(action === 'manifest' || action === 'cleanupIncomplete' ? ['backupId'] : []),
            ...(action === 'setPreference' ? ['policy'] : []),
          ]
          if (
            args.length !== 1 ||
            typeof input !== 'object' ||
            input === null ||
            Array.isArray(input) ||
            Object.keys(input).length !== fields.length ||
            fields.some((field) => !Object.hasOwn(input, field))
          ) {
            throw new HttpOperationError('invalid-request', 'Backup parameters are invalid.')
          }
          const data = input as Record<string, unknown>
          if (
            !isOpaqueId(data.projectId) ||
            !isOpaqueId(data.rootId) ||
            (fields.includes('backupId') && !isOpaqueId(data.backupId))
          ) {
            throw new HttpOperationError('invalid-request', 'The backup reference is invalid.')
          }
          if (
            (action === 'setPreference' && hasTargetOperation()) ||
            ((action === 'rotate' || action === 'cleanupIncomplete') && hasRunningWork())
          ) {
            throw new HttpOperationError(
              'busy',
              'Wait for the current file operation to finish before changing backup settings or cleaning up backups.',
            )
          }
          if (action === 'setPreference') {
            if (!(data.policy === null || isSyncBackupPolicy(data.policy))) {
              throw new HttpOperationError('invalid-request', 'Backup settings are invalid.')
            }
            if (
              !library
                .snapshot()
                .config.games.some(
                  (game) => game.id === data.projectId && game.rootId === data.rootId,
                )
            ) {
              throw new HttpOperationError(
                'invalid-request',
                "Configure this game's local directory first.",
              )
            }
            value = await store.setPreference(data.projectId, data.rootId, data.policy)
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
                throw new HttpOperationError(
                  'not-found',
                  'The backup does not exist or its ownership does not match.',
                )
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
          throw new HttpOperationError('resource-limit', 'The backup response exceeds the limit.')
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
