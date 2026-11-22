import { BATCH_LIMITS, isOpaqueId, isSyncBackupPolicy } from '@savedata-sync/shared'
import type { SyncBackupPolicy } from '@savedata-sync/shared'
import { BACKUP_CHANNELS } from '../bridge/backup-bridge.ts'
import type { WindowsBackupStore } from './backup-store.ts'
import type { DesktopLibrary } from './library-store.ts'
import { HttpOperationError, toHttpError } from './http-errors.ts'
import { hasTargetOperation } from './target-operation.ts'
import type { ChannelRegistry } from './channel-registry.ts'

/**
 * 注册备份接口的通道处理函数。
 *
 * @param openPath 用系统文件管理器打开路径；打不开时 reject。
 * @returns 移除这些处理函数的函数。
 */
export function registerBackupIpc(
  ipc: ChannelRegistry,
  store: WindowsBackupStore,
  library: DesktopLibrary,
  openPath: (path: string) => Promise<void>,
  hasRunningWork: () => boolean = () => false,
): () => void {
  for (const [action, channel] of Object.entries(BACKUP_CHANNELS)) {
    ipc.handle(channel, async (...args: unknown[]) => {
      try {
        let value: unknown
        if (action === 'read') {
          if (args.length) {
            throw new HttpOperationError('invalid-request', 'Backup read parameters are invalid.')
          }
          value = { displayPath: store.path, settings: await store.settings() }
        } else if (action === 'openFolder') {
          if (args.length) {
            throw new HttpOperationError('invalid-request', 'Backup parameters are invalid.')
          }
          const folder = await store.root()
          try {
            await openPath(folder)
          } catch (cause) {
            throw new HttpOperationError(
              'io-failure',
              'The backup folder could not be opened.',
              cause,
            )
          }
          value = null
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
        } else if (action === 'deleteGameBackups') {
          const input = args[0]
          if (
            args.length !== 1 ||
            typeof input !== 'object' ||
            input === null ||
            Array.isArray(input) ||
            Object.keys(input).length !== 1 ||
            !isOpaqueId((input as Record<string, unknown>).projectId)
          ) {
            throw new HttpOperationError('invalid-request', 'The game reference is invalid.')
          }
          if (hasRunningWork()) {
            throw new HttpOperationError(
              'busy',
              'Wait for the current file operation to finish before removing a game.',
            )
          }
          await store.deleteGameBackups((input as { projectId: string }).projectId)
          value = null
        } else {
          const input = args[0]
          const fields = [
            'projectId',
            ...(action === 'manifest' || action === 'cleanupIncomplete' || action === 'deleteBackup'
              ? ['backupId']
              : []),
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
            (fields.includes('backupId') && !isOpaqueId(data.backupId))
          ) {
            throw new HttpOperationError('invalid-request', 'The backup reference is invalid.')
          }
          if (
            (action === 'setPreference' && hasTargetOperation()) ||
            ((action === 'rotate' || action === 'cleanupIncomplete' || action === 'deleteBackup') &&
              hasRunningWork())
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
                .config.games.some((game) => game.id === data.projectId && game.rootId !== null)
            ) {
              throw new HttpOperationError(
                'invalid-request',
                "Configure this game's local directory first.",
              )
            }
            value = await store.setPreference(data.projectId, data.policy)
          } else if (action === 'rotate') {
            await store.rotate(data.projectId)
            value = null
          } else if (action === 'cleanupIncomplete') {
            await store.cleanupIncomplete(data.projectId, data.backupId as string)
            value = null
          } else if (action === 'deleteBackup') {
            await store.deleteBackup(data.projectId, data.backupId as string)
            value = null
          } else {
            const listing = await store.list(data.projectId)
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
