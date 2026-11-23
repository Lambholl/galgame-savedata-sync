import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Progress } from 'antd'
import { Button } from 'antd-mobile'
import { formatBytes, formatShortDateTime, toShownError } from '@savedata-sync/shared'
import type { LibraryGame, ShownError, SyncManualBackupState } from '@savedata-sync/shared'
import {
  BackupLeftoverNotice,
  BackupLibraryBlock,
  BackupTimeline,
  cleanupIncompleteBackups,
  PathText,
  useT,
} from '@savedata-sync/shared/ui'
import { useAppMessage } from '../../app/app-message'
import { useFailureMessage } from '../../app/failure-message'
import { ConfirmationDialog } from '../../components/ConfirmationDialog'
import { EmptyState } from '../../components/EmptyState'
import type {
  MobileBackupDetails,
  MobileRestoreDetails,
  MobileSyncAdapter,
} from '../../platform/sync-adapter'

/**
 * 备份与恢复：顶部是备份库的保留份数和立即备份入口，下面按时间列出备份；点“恢复”准备好后触发 onOpenRestore 打开恢复预览页。
 * 恢复前总会先备份当前文件。
 */
export function BackupPage({
  sync,
  game,
  restore,
  isDisabled,
  onChanged,
  onSettings,
  onOpenAppSettings,
  onOpenRestore,
  onOverlayChange,
}: {
  readonly sync: MobileSyncAdapter
  readonly game: LibraryGame
  readonly restore: MobileRestoreDetails | null
  readonly isDisabled: boolean
  readonly onChanged: () => void
  readonly onSettings: () => void
  /** 打开应用设置，修改备份库的保留份数。 */
  readonly onOpenAppSettings: () => void
  /** 打开恢复页；sourceName 是计划里来源一端的名称。 */
  readonly onOpenRestore: (restoreId: string, sourceName: string) => void
  /** 打开弹层时交给应用一个关闭函数，供返回键使用；关闭后传 null。 */
  readonly onOverlayChange: (close: (() => void) | null) => void
}): React.JSX.Element {
  const t = useT()
  const [details, setDetails] = useState<MobileBackupDetails | null>(null)
  /** 最近一次失败，连同出错的操作。 */
  const [error, setError] = useState<{
    readonly context: string
    readonly error: ShownError
  } | null>(null)
  const [isBusy, setIsBusy] = useState(false)
  const [version, setVersion] = useState(0)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [manualTask, setManualTask] = useState<SyncManualBackupState | null>(null)
  const [isStartingManual, setIsStartingManual] = useState(false)
  const [isCancellingManual, setIsCancellingManual] = useState(false)
  const current = restore?.state.projectId === game.id ? restore : null
  const operating = useRef(false)
  const handledManualId = useRef<string | null>(null)
  const onChangedRef = useRef(onChanged)
  useLayoutEffect(() => {
    onChangedRef.current = onChanged
  }, [onChanged])
  // 失败用 Message 提示一次；读不到备份时正文留一个重试入口。
  const [appMessage, messageHolder] = useAppMessage()
  const [showFailure, failureHolder] = useFailureMessage()
  useEffect(() => {
    showFailure(error?.error ?? null, error?.context ?? null)
  }, [error, showFailure])
  useEffect(() => {
    if (!game.rootId) {
      return
    }
    let isCurrent = true
    sync
      .backups(game.id)
      .then((value) => {
        if (isCurrent) {
          setDetails(value)
          setError(null)
        }
      })
      .catch((cause: unknown) => {
        if (isCurrent) {
          setDetails(null)
          setError({ context: t('backup.readFailed'), error: toShownError(cause) })
        }
      })
    return () => {
      isCurrent = false
    }
  }, [sync, game.id, game.rootId, version, current?.state.status, t])
  useEffect(() => {
    if (!game.rootId) {
      return
    }
    let isCurrent = true
    sync
      .currentManualBackup()
      .then((value) => {
        if (isCurrent && value?.projectId === game.id) {
          setManualTask(value)
        }
      })
      .catch(() => {
        /* 仅恢复进行中的本机手动备份展示；查询失败时不影响备份列表读取。 */
      })
    return () => {
      isCurrent = false
    }
  }, [sync, game.id, game.rootId])
  const activeManual = manualTask?.projectId === game.id ? manualTask : null
  const isManualRunning = activeManual?.status === 'running'
  const runningManualId = isManualRunning ? activeManual.taskId : null
  useEffect(() => {
    if (!runningManualId) {
      return
    }
    let isPolling = true
    let timer: ReturnType<typeof setTimeout> | null = null
    function poll(taskId: string): void {
      sync
        .manualBackupState(taskId)
        .then((next) => {
          if (!isPolling) {
            return
          }
          setManualTask(next)
          if (next.status === 'running') {
            timer = setTimeout(() => poll(taskId), 250)
            return
          }
          setIsCancellingManual(false)
          if (handledManualId.current !== next.taskId) {
            handledManualId.current = next.taskId
            if (next.status === 'succeeded') {
              const count = next.fileCount ?? 0
              appMessage.show({
                type: 'success',
                content: `${t('backup.manualDone')} · ${t('backup.manualDoneDetail', { count })}`,
                slot: 'manual-backup',
              })
              if (next.cleanupError) {
                setError({
                  context: t('backup.manualDone'),
                  error: toShownError(next.cleanupError),
                })
              }
            } else if (next.status === 'empty') {
              appMessage.show({
                type: 'info',
                content: t('backup.manualEmpty'),
                slot: 'manual-backup',
              })
            } else if (next.status === 'cancelled') {
              appMessage.show({
                type: 'info',
                content: t('backup.manualCancelled'),
                slot: 'manual-backup',
              })
              if (next.cleanupError) {
                setError({
                  context: t('backup.manualCancelled'),
                  error: toShownError(next.cleanupError),
                })
              }
            } else {
              setError({
                context: t('backup.manualFailed'),
                error: toShownError(next.error ?? next.cleanupError),
              })
            }
            setVersion((value) => value + 1)
            onChangedRef.current()
          }
        })
        .catch((cause: unknown) => {
          if (!isPolling) {
            return
          }
          setManualTask(null)
          setIsCancellingManual(false)
          setError({ context: t('backup.manualFailed'), error: toShownError(cause) })
          setVersion((value) => value + 1)
          onChangedRef.current()
        })
    }
    timer = setTimeout(() => poll(runningManualId), 250)
    return () => {
      isPolling = false
      if (timer) {
        clearTimeout(timer)
      }
    }
  }, [runningManualId, sync, appMessage, t])
  useEffect(() => {
    if (!deleting) {
      return
    }
    onOverlayChange(() => setDeleting(null))
    return () => onOverlayChange(null)
  }, [deleting, onOverlayChange])
  const keepCount = details?.info.settings.keepCount ?? null
  const isLocked = isDisabled || isBusy || isManualRunning || isStartingManual
  function reload(): void {
    setVersion((value) => value + 1)
    onChanged()
  }
  function run(work: () => Promise<void>): void {
    if (operating.current) {
      return
    }
    operating.current = true
    setIsBusy(true)
    setError(null)
    work()
      .then(reload)
      .catch((cause: unknown) => {
        setError({ context: t('app.actionFailed'), error: toShownError(cause) })
        // 批量清理可能只成功了一部分，列表要反映实际结果。
        setVersion((value) => value + 1)
        onChanged()
      })
      .finally(() => {
        operating.current = false
        setIsBusy(false)
      })
  }
  function startManualBackup(): void {
    if (isLocked) {
      return
    }
    setIsStartingManual(true)
    setError(null)
    sync
      .startManualBackup(game.id)
      .then((next) => {
        setManualTask(next)
        onChanged()
      })
      .catch((cause: unknown) => {
        setError({ context: t('backup.manualFailed'), error: toShownError(cause) })
      })
      .finally(() => {
        setIsStartingManual(false)
      })
  }
  function cancelManualBackup(): void {
    if (!runningManualId || isCancellingManual) {
      return
    }
    setIsCancellingManual(true)
    sync
      .cancelManualBackup(runningManualId)
      .then((next) => {
        setManualTask(next)
      })
      .catch((cause: unknown) => {
        setIsCancellingManual(false)
        setError({ context: t('app.actionFailed'), error: toShownError(cause) })
      })
  }
  const backups = [...(details?.listing.backups ?? [])].sort((a, b) => b.createdAt - a.createdAt)
  /** 计划里来源一端的名称：备份时间，找不到这份备份时写“备份”。 */
  function sourceName(backupId: string): string {
    const backup = backups.find((item) => item.backupId === backupId)
    return backup ? formatShortDateTime(backup.createdAt) : t('backup.list')
  }
  function prepare(backupId: string): void {
    run(async () => {
      if (restore) {
        await sync.releaseRestore(restore.state.restoreId)
      }
      const state = await sync.prepareRestore(game.id, backupId)
      onOpenRestore(state.restoreId, sourceName(backupId))
    })
  }
  const incomplete = details?.listing.incomplete ?? []
  const manualProgressText =
    activeManual?.status === 'running'
      ? activeManual.stage === 'scanning'
        ? t('backup.manualScanning')
        : activeManual.totalBytes > 0
          ? t('backup.manualRunningBytes', {
              copied: formatBytes(activeManual.bytesCopied),
              total: formatBytes(activeManual.totalBytes),
            })
          : t('backup.manualRunning')
      : null
  const manualPercent =
    activeManual?.status === 'running' && activeManual.totalBytes > 0
      ? Math.min(100, Math.round((activeManual.bytesCopied / activeManual.totalBytes) * 100))
      : 0
  if (!game.rootId) {
    return (
      <EmptyState description={t('backup.noFolder')}>
        <Button size="small" onClick={onSettings}>
          {t('page.gameSettings')}
        </Button>
      </EmptyState>
    )
  }
  return (
    <div className="page-stack">
      {messageHolder}
      {failureHolder}
      {error && !details ? (
        <div className="empty-state">
          <p>{error.context}</p>
          <div className="action-row">
            <Button size="small" disabled={isBusy} onClick={reload}>
              {t('common.retry')}
            </Button>
          </div>
        </div>
      ) : null}
      {keepCount === null ? null : (
        <BackupLibraryBlock keepCount={keepCount} location={null} onEdit={onOpenAppSettings} />
      )}
      {details ? (
        <Button
          color="primary"
          block
          loading={isStartingManual}
          disabled={isLocked}
          onClick={startManualBackup}
        >
          {t('backup.manualStart')}
        </Button>
      ) : null}
      {activeManual?.status === 'running' && manualProgressText ? (
        <div className="backup-manual-card">
          <div className="backup-manual-body">
            <span>{manualProgressText}</span>
            <Progress
              percent={manualPercent}
              status={activeManual.stage === 'scanning' ? 'active' : 'normal'}
              showInfo={false}
              size="small"
            />
          </div>
          <Button
            size="small"
            loading={isCancellingManual || activeManual.isCancelRequested}
            onClick={cancelManualBackup}
          >
            {t('common.cancel')}
          </Button>
        </div>
      ) : null}
      {incomplete.length > 0 && (
        <BackupLeftoverNotice
          items={incomplete}
          isDisabled={isLocked}
          onCleanup={() =>
            run(() => cleanupIncompleteBackups(incomplete, (id) => sync.cleanupBackup(game.id, id)))
          }
        />
      )}
      {keepCount === null ? null : (
        <section>
          <h3 className="group-title">
            {t('backup.list')}
            <small>
              {backups.length} / {keepCount}
            </small>
          </h3>
          <BackupTimeline
            backups={backups.map((item) => ({
              id: item.backupId,
              createdAt: item.createdAt,
              reason: item.reason,
              fileCount: item.fileCount,
              totalBytes: item.totalFileBytes,
            }))}
            action={{
              kind: 'restore',
              isDisabled: isLocked,
              onRestore: prepare,
              onDelete: setDeleting,
            }}
          />
        </section>
      )}
      {current ? (
        <Button
          onClick={() => onOpenRestore(current.state.restoreId, sourceName(current.state.backupId))}
        >
          {t('backup.openRestore')}
        </Button>
      ) : null}
      {details ? (
        <p className="foot-note">
          {t('backup.location')} <PathText path={details.info.displayPath} />
        </p>
      ) : null}
      <ConfirmationDialog
        confirmation={
          deleting
            ? {
                title: t('backup.deleteTitle'),
                text: t('backup.deleteText', { time: sourceName(deleting) }),
                okType: 'danger',
                okText: t('backup.delete'),
                work: () => sync.deleteBackup(game.id, deleting),
              }
            : null
        }
        isBusy={isBusy}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) {
            setDeleting(null)
            run(() => sync.deleteBackup(game.id, deleting))
          }
        }}
      />
    </div>
  )
}
