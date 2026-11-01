import { useEffect, useRef, useState } from 'react'
import { Button, List } from 'antd-mobile'
import { ExclamationCircleOutlined } from '@ant-design/icons'
import { formatShortDateTime, resolveBackupPolicy } from '@savedata-sync/shared'
import type { LibraryGame, SyncBackupPolicy } from '@savedata-sync/shared'
import {
  BackupPolicyBlock,
  BackupTimeline,
  PathText,
  RestoreSummary,
  SyncPlanSummary,
  useLocale,
  useT,
} from '@savedata-sync/shared/ui'
import type {
  MobileBackupDetails,
  MobileRestoreDetails,
  MobileSyncAdapter,
} from '../../platform/sync-adapter'
import { BackupPolicyFields } from '../../components/BackupPolicyFields'
import { Sheet } from '../../components/Sheet'
import { SwitchItem } from '../../components/SwitchItem'

type PolicyMode = 'follow' | 'custom'

/**
 * 备份与恢复：顶部是备份策略，下面按时间列出备份；点“恢复”在弹层里先看恢复预览，
 * 确认后结果留在同一弹层。恢复前总会先备份当前文件。
 */
export function BackupPage({
  sync,
  game,
  restore,
  isDisabled,
  onChanged,
  onSettings,
  onOpenAppSettings,
  onOverlayChange,
}: {
  readonly sync: MobileSyncAdapter
  readonly game: LibraryGame
  readonly restore: MobileRestoreDetails | null
  readonly isDisabled: boolean
  readonly onChanged: () => void
  readonly onSettings: () => void
  /** 打开应用设置，修改全局备份设置。 */
  readonly onOpenAppSettings: () => void
  /** 打开弹层时交给应用一个关闭函数，供返回键使用；关闭后传 null。 */
  readonly onOverlayChange: (close: (() => void) | null) => void
}): React.JSX.Element {
  const t = useT()
  const locale = useLocale()
  const [details, setDetails] = useState<MobileBackupDetails | null>(null)
  const [error, setError] = useState('')
  const [isBusy, setIsBusy] = useState(false)
  const [version, setVersion] = useState(0)
  const [isPolicyOpen, setIsPolicyOpen] = useState(false)
  const [mode, setMode] = useState<PolicyMode>('follow')
  const [draft, setDraft] = useState<SyncBackupPolicy | null>(null)
  const current = restore?.state.projectId === game.id ? restore : null
  const [isRestoreOpen, setIsRestoreOpen] = useState(current !== null)
  const operating = useRef(false)
  const saving = useRef(Promise.resolve())
  const state = current?.state
  const plan = current?.plan
  useEffect(() => {
    let isCurrent = true
    sync
      .backups(game.id)
      .then((value) => {
        if (isCurrent) {
          setDetails(value)
          setError('')
        }
      })
      .catch((cause: unknown) => {
        if (isCurrent) {
          setDetails(null)
          setError(cause instanceof Error ? cause.message : t('common.unknown'))
        }
      })
    return () => {
      isCurrent = false
    }
  }, [sync, game.id, game.rootId, version, state?.status, t])
  const isRestoreShown = isRestoreOpen && current !== null
  const isOverlayOpen = isPolicyOpen || isRestoreShown
  useEffect(() => {
    if (!isOverlayOpen) {
      return
    }
    onOverlayChange(() => {
      setIsPolicyOpen(false)
      setIsRestoreOpen(false)
    })
    return () => onOverlayChange(null)
  }, [isOverlayOpen, onOverlayChange])
  const settings = details?.info.settings
  const policy = details && resolveBackupPolicy(details.info.settings, game.id, details.root.rootId)
  const isLocked = isDisabled || isBusy
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
    setError('')
    work()
      .then(reload)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : t('common.unknown'))
        onChanged()
      })
      .finally(() => {
        operating.current = false
        setIsBusy(false)
      })
  }
  function openPolicy(): void {
    if (!policy) {
      return
    }
    setMode(policy.isCustom ? 'custom' : 'follow')
    setDraft({ shouldBackup: policy.shouldBackup, keepCount: policy.keepCount })
    setIsPolicyOpen(true)
  }
  /** 弹层里的改动立即保存，依次写入；跟随全局时删掉单独设置。 */
  function savePolicy(nextMode: PolicyMode, nextDraft: SyncBackupPolicy): void {
    setMode(nextMode)
    setDraft(nextDraft)
    setError('')
    const next = nextMode === 'custom' ? nextDraft : null
    saving.current = saving.current
      .then(() => sync.setBackup(game.id, next))
      .then(reload)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : t('common.unknown'))
        reload()
      })
  }
  function prepare(backupId: string): void {
    setIsRestoreOpen(true)
    run(async () => {
      if (restore) {
        await sync.releaseRestore(restore.state.restoreId)
      }
      await sync.prepareRestore(game.id, backupId)
    })
  }
  /** 关闭恢复弹层：准备中的取消，未开始或已结束的释放；进行中的只收起，恢复继续。 */
  function closeRestore(): void {
    setIsRestoreOpen(false)
    if (!state || state.status === 'running') {
      return
    }
    const id = state.restoreId
    run(() => (state.status === 'preparing' ? sync.cancelRestore(id) : sync.releaseRestore(id)))
  }
  const backups = details?.listing.backups ?? []
  const backup = backups.find((item) => item.backupId === state?.backupId)
  const backupTime = backup ? formatShortDateTime(backup.createdAt, locale, Date.now()) : ''
  const incomplete = details?.listing.incomplete ?? []
  const isOldFolder = state !== undefined && state.rootId !== game.rootId
  return (
    <div className="page-stack">
      {error && (
        <div className="notice notice-error" role="alert">
          <p>{t('backup.readFailed', { message: error })}</p>
          <div className="action-row">
            <Button size="small" disabled={isBusy} onClick={reload}>
              {t('common.retry')}
            </Button>
            {!game.rootId && (
              <Button size="small" onClick={onSettings}>
                {t('page.gameSettings')}
              </Button>
            )}
          </div>
        </div>
      )}
      {policy && (
        <BackupPolicyBlock
          isEnabled={policy.shouldBackup}
          keepCount={policy.keepCount}
          isCustom={policy.isCustom}
          location={null}
          onEdit={isLocked ? null : openPolicy}
        />
      )}
      {details && policy && (
        <section>
          <h3 className="group-title">
            {t('backup.list')}
            <small>
              {backups.length} / {policy.keepCount}
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
            action={{ kind: 'restore', isDisabled: isLocked, onRestore: prepare }}
          />
        </section>
      )}
      {incomplete.length > 0 && (
        <div className="notice notice-warning">
          <p>
            <ExclamationCircleOutlined /> {t('backup.incomplete', { count: incomplete.length })}
          </p>
          <Button
            size="small"
            disabled={isLocked}
            onClick={() =>
              run(async () => {
                for (const id of incomplete) {
                  await sync.cleanupBackup(game.id, id)
                }
              })
            }
          >
            {t('backup.cleanup')}
          </Button>
        </div>
      )}
      {current && !isRestoreOpen && (
        <Button onClick={() => setIsRestoreOpen(true)}>{t('backup.openRestore')}</Button>
      )}
      {details && (
        <p className="foot-note">
          {t('backup.privateNote')}
          <br />
          {t('backup.location')} <PathText path={details.info.displayPath} />
        </p>
      )}
      <Sheet
        isOpen={isPolicyOpen}
        title={t('backup.policyTitle', { name: game.name })}
        onClose={() => setIsPolicyOpen(false)}
      >
        {settings && draft && (
          <List>
            <SwitchItem
              title={t('backup.followGlobal')}
              isChecked={mode === 'follow'}
              isDisabled={isDisabled}
              onChange={(isFollowing) =>
                // 取消跟随时从当前显示的全局值开始单独设置。
                isFollowing ? savePolicy('follow', draft) : savePolicy('custom', settings.defaults)
              }
            />
            {mode === 'follow' ? (
              <>
                <BackupPolicyFields policy={settings.defaults} isDisabled onChange={() => {}} />
                <List.Item
                  onClick={() => {
                    setIsPolicyOpen(false)
                    onOpenAppSettings()
                  }}
                >
                  {t('backup.editGlobal')}
                </List.Item>
              </>
            ) : (
              <BackupPolicyFields
                policy={draft}
                isDisabled={isDisabled}
                onChange={(next) => savePolicy('custom', next)}
              />
            )}
          </List>
        )}
      </Sheet>
      <Sheet
        isOpen={isRestoreShown}
        title={backupTime ? t('backup.restoreTitle', { time: backupTime }) : t('backup.restore')}
        isBusy={isBusy}
        onClose={closeRestore}
      >
        {state && (
          <div className="page-stack">
            {state.status === 'ready' && plan ? (
              <>
                <SyncPlanSummary
                  key={plan.planId}
                  plan={plan}
                  source={{ name: backupTime || t('backup.list'), kind: 'backup' }}
                  target={{ name: t('transfer.local'), kind: 'phone' }}
                  backupKeepCount={null}
                />
                {isOldFolder && <p className="notice notice-warning">{t('backup.oldFolder')}</p>}
                <Button
                  block
                  color="primary"
                  disabled={isLocked || !plan.canExecute || isOldFolder}
                  onClick={() => run(() => sync.executeRestore(state.restoreId).then(() => {}))}
                >
                  {t('backup.confirmRestore')}
                </Button>
              </>
            ) : (
              <>
                <RestoreSummary
                  phase={state.status === 'ready' ? 'preparing' : state.status}
                  progress={null}
                  result={state.result}
                  error={state.error?.message ?? null}
                  cleanupError={null}
                  onRetryCleanup={
                    state.result?.cleanupError && !isBusy
                      ? () => run(() => sync.cleanupRestore())
                      : null
                  }
                />
                {state.status === 'preparing' ? (
                  <Button block disabled={isBusy} onClick={closeRestore}>
                    {t('common.cancel')}
                  </Button>
                ) : (
                  state.status !== 'running' && (
                    <Button block color="primary" disabled={isBusy} onClick={closeRestore}>
                      {t('backup.done')}
                    </Button>
                  )
                )}
              </>
            )}
          </div>
        )}
      </Sheet>
    </div>
  )
}
