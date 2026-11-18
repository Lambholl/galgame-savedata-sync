import { useEffect, useRef, useState } from 'react'
import { Button, Empty, Form, Modal, Switch } from 'antd'
import { DeleteOutlined, FolderOpenOutlined, HistoryOutlined } from '@ant-design/icons'
import {
  formatBytes,
  formatShortDateTime,
  resolveBackupPolicy,
  toShownError,
  unwrap,
} from '@savedata-sync/shared'
import type {
  DirectoryReference,
  LibraryGame,
  ShownError,
  SyncBackupManifest,
  SyncBackupPolicy,
} from '@savedata-sync/shared'
import type { DesktopBackupInfo, DesktopBackupList } from '../../../../bridge/backup-bridge.ts'
import {
  BackupFiles,
  BackupLeftoverNotice,
  BackupPolicyBlock,
  BackupTimeline,
  cleanupIncompleteBackups,
  useT,
} from '@savedata-sync/shared/ui'
import { useFailureMessage } from '../../app/failure-message.ts'
import { desktopBackups, desktopSync } from '../../platform/sync-adapter.ts'
import { SETTING_FORM } from '../settings/setting-form.ts'
import { BackupPolicyFields } from './BackupPolicyFields.tsx'
import { RestoreDetails } from './RestoreDetails.tsx'

type PolicyMode = 'follow' | 'custom'

/** 一个游戏的备份与恢复页：顶部是备份设置，左侧是备份时间线，右侧是所选备份的文件和恢复入口。 */
export function BackupPage({
  roots,
  game,
  isActive,
  hasRunningWork,
  onOpenSettings,
  onOpenAppSettings,
  onChanged,
}: {
  readonly roots: readonly DirectoryReference[]
  readonly game: LibraryGame | null
  readonly isActive: boolean
  readonly hasRunningWork: boolean
  readonly onOpenSettings: () => void
  /** 打开应用设置，修改全局备份设置。 */
  readonly onOpenAppSettings: () => void
  readonly onChanged: () => void
}): React.JSX.Element {
  const t = useT()
  const [info, setInfo] = useState<DesktopBackupInfo | null>(null)
  const [listing, setListing] = useState<DesktopBackupList | null>(null)
  // 最近一次读完（成功或失败）的列表请求；和当前请求不同时表示正在读取。
  const [loadedListingKey, setLoadedListingKey] = useState<string | null>(null)
  const [isBusy, setIsBusy] = useState(false)
  const [error, setError] = useState<{ context: string; error: ShownError } | null>(null)
  const [version, setVersion] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // 读到的文件清单连同它属于哪个备份一起保存，切换备份后旧结果自然失效。
  const [manifestResult, setManifestResult] = useState<{
    key: string
    manifest: SyncBackupManifest | null
    error: { context: string; error: ShownError } | null
  } | null>(null)
  const [restoreId, setRestoreId] = useState<string | null>(null)
  const [isPolicyOpen, setIsPolicyOpen] = useState(false)
  const [mode, setMode] = useState<PolicyMode>('follow')
  const [draft, setDraft] = useState<SyncBackupPolicy | null>(null)
  const [isDeleteOpen, setIsDeleteOpen] = useState(false)
  const isCurrent = useRef(true)
  const saving = useRef(Promise.resolve())
  useEffect(() => {
    isCurrent.current = true
    return () => {
      isCurrent.current = false
    }
  }, [])
  const rootId = game?.rootId ?? null
  const projectId = game?.id ?? null
  const listingKey = `${projectId ?? ''}:${version}`
  const isLoading = loadedListingKey !== listingKey
  const backups = listing?.backups ?? []
  const selected = backups.find((item) => item.backupId === selectedId) ?? backups[0] ?? null
  const selectedKey = selected ? `${selected.projectId}/${selected.backupId}` : null
  const shownManifest = manifestResult?.key === selectedKey ? manifestResult : null
  const manifest = shownManifest?.manifest ?? null
  const manifestError = shownManifest?.error ?? null
  const isReading = selectedKey !== null && shownManifest === null
  // 失败用 Message 提示一次；读不到列表时正文留一个重试入口。
  const [showFailure, failureHolder] = useFailureMessage()
  const failure = error ?? manifestError
  useEffect(() => {
    showFailure(failure?.error ?? null, failure?.context ?? null)
  }, [failure, showFailure])
  useEffect(() => {
    let hasResult = true
    async function read(): Promise<void> {
      const api = desktopBackups()
      const details = unwrap(await api.read())
      const values = projectId ? unwrap(await api.list(projectId)) : null
      if (hasResult) {
        setInfo(details)
        setListing(values)
        setError(null)
      }
    }
    void read()
      .catch((cause: unknown) => {
        if (hasResult) {
          setError({ context: t('backup.readFailed'), error: toShownError(cause) })
        }
      })
      .finally(() => {
        if (hasResult) {
          setLoadedListingKey(listingKey)
        }
      })
    return () => {
      hasResult = false
    }
  }, [listingKey, projectId, t])
  // 对方传入或恢复结束时可能新建或轮换了备份，页面开着也要重新读一次列表。
  const wasRunning = useRef(hasRunningWork)
  useEffect(() => {
    if (wasRunning.current && !hasRunningWork) {
      setVersion((value) => value + 1)
    }
    wasRunning.current = hasRunningWork
  }, [hasRunningWork])
  // 所选备份变化时读取它的文件清单；切换得快时只保留最后一次的结果。
  useEffect(() => {
    if (!selected || selectedKey === null) {
      return
    }
    let hasResult = true
    async function read(): Promise<void> {
      if (!selected || selectedKey === null) {
        return
      }
      const value = unwrap(await desktopBackups().manifest(selected.projectId, selected.backupId))
      if (hasResult) {
        setManifestResult({ key: selectedKey, manifest: value, error: null })
      }
    }
    read().catch((cause: unknown) => {
      if (hasResult && selectedKey !== null) {
        setManifestResult({
          key: selectedKey,
          manifest: null,
          error: { context: t('backup.readFailed'), error: toShownError(cause) },
        })
      }
    })
    return () => {
      hasResult = false
    }
  }, [selected, selectedKey, t])
  function refresh(): void {
    setVersion((value) => value + 1)
    onChanged()
  }
  function run(work: () => Promise<void>): void {
    if (isBusy) {
      return
    }
    setIsBusy(true)
    setError(null)
    void work()
      .catch((cause: unknown) => {
        if (isCurrent.current) {
          setError({ context: t('app.actionFailed'), error: toShownError(cause) })
        }
      })
      .finally(() => {
        if (isCurrent.current) {
          setIsBusy(false)
          refresh()
        }
      })
  }
  if (!game) {
    return <Empty description={t('backup.noGame')} />
  }
  if (!rootId) {
    return (
      <Empty description={t('backup.noFolder')}>
        <Button onClick={onOpenSettings}>{t('page.gameSettings')}</Button>
      </Empty>
    )
  }
  const settings = info?.settings ?? null
  const policy = settings && resolveBackupPolicy(settings, game.id)
  function openPolicy(): void {
    if (!policy) {
      return
    }
    setMode(policy.isCustom ? 'custom' : 'follow')
    setDraft({ shouldBackup: policy.shouldBackup, keepCount: policy.keepCount })
    setIsPolicyOpen(true)
  }
  /** 弹窗里的改动立即保存，依次写入；跟随全局时删掉单独设置。 */
  function savePolicy(nextMode: PolicyMode, nextDraft: SyncBackupPolicy): void {
    if (!game) {
      return
    }
    const projectId = game.id
    setMode(nextMode)
    setDraft(nextDraft)
    setError(null)
    const next = nextMode === 'custom' ? nextDraft : null
    saving.current = saving.current
      .then(async () => {
        unwrap(await desktopBackups().setPreference(projectId, next))
      })
      .catch((cause: unknown) => {
        if (isCurrent.current) {
          setError({ context: t('backup.saveFailed'), error: toShownError(cause) })
        }
      })
      .finally(() => {
        if (isCurrent.current) {
          refresh()
        }
      })
  }
  function prepare(): void {
    if (!selected || !rootId) {
      return
    }
    const item = selected
    const target = rootId
    // 备份可能来自游戏之前用过的目录，恢复总是写进游戏当前的目录。
    run(async () => {
      const next = unwrap(await desktopSync().prepareRestore(item.projectId, target, item.backupId))
      if (isCurrent.current) {
        setRestoreId(next.restoreId)
      }
    })
  }
  function deleteSelected(): void {
    setIsDeleteOpen(false)
    if (!selected) {
      return
    }
    const item = selected
    setSelectedId(null)
    run(async () => {
      unwrap(await desktopBackups().deleteBackup(item.projectId, item.backupId))
    })
  }
  const incomplete = listing?.incomplete ?? []
  const when = (value: number): string => formatShortDateTime(value)
  let detail: React.ReactNode
  if (selected) {
    const root =
      roots.find((item) => item.rootId === selected.rootId) ??
      roots.find((item) => item.rootId === rootId)
    detail = (
      <>
        <div className="backup-detail-head">
          <h2>{when(selected.createdAt)}</h2>
          <div className="backup-detail-actions">
            <Button
              danger
              icon={<DeleteOutlined />}
              disabled={isBusy || isActive || hasRunningWork}
              onClick={() => setIsDeleteOpen(true)}
            >
              {t('backup.delete')}
            </Button>
            <Button
              type="primary"
              icon={<HistoryOutlined />}
              loading={isBusy}
              disabled={isActive || hasRunningWork}
              onClick={prepare}
            >
              {t('backup.restore')}
            </Button>
          </div>
          <p>
            {t(`backup.reason.${selected.reason}`)} ·{' '}
            {t('backup.files', {
              count: selected.fileCount,
              size: formatBytes(selected.totalFileBytes),
            })}
          </p>
        </div>
        <BackupFiles
          key={selected.backupId}
          rootName={root?.displayName ?? '—'}
          files={isReading ? null : (manifest?.files ?? (manifestError ? [] : null))}
          failure={manifestError?.context ?? null}
        />
      </>
    )
  } else {
    detail = null
  }
  return (
    <div className="library-stack">
      {policy ? (
        <BackupPolicyBlock
          isEnabled={policy.shouldBackup}
          keepCount={policy.keepCount}
          isCustom={policy.isCustom}
          location={info?.displayPath ?? null}
          onEdit={isActive ? null : openPolicy}
        />
      ) : null}
      {failureHolder}
      {/* 恢复预览在与传输计划相同的确认抽屉里打开，不改动本页内容。 */}
      {restoreId ? (
        <RestoreDetails
          key={restoreId}
          restoreId={restoreId}
          gameName={game.name}
          sourceName={selected ? when(selected.createdAt) : t('backup.list')}
          isActive={isActive}
          onClose={() => {
            setRestoreId(null)
            refresh()
          }}
          onChanged={onChanged}
          onOpenBackup={null}
        />
      ) : null}
      {error && !listing && !isLoading ? (
        <Empty description={error.context}>
          <Button onClick={refresh}>{t('common.retry')}</Button>
        </Empty>
      ) : null}
      {incomplete.length > 0 && (
        <BackupLeftoverNotice
          items={incomplete}
          isDisabled={isBusy || hasRunningWork}
          onCleanup={() =>
            run(() =>
              cleanupIncompleteBackups(incomplete, async (id) => {
                unwrap(await desktopBackups().cleanupIncomplete(game.id, id))
              }),
            )
          }
        />
      )}
      {(isLoading || error) && !listing ? null : (
        <div className="backup-columns">
          <section>
            <h3 className="group-title">
              {t('backup.list')}
              <span className="group-title-end">
                {policy ? (
                  <small>
                    {backups.length} / {policy.keepCount}
                  </small>
                ) : null}
                <Button
                  size="small"
                  icon={<FolderOpenOutlined />}
                  onClick={() =>
                    run(async () => {
                      unwrap(await desktopBackups().openFolder())
                    })
                  }
                >
                  {t('backup.openFolder')}
                </Button>
              </span>
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
                kind: 'select',
                selectedId: selected?.backupId ?? null,
                onSelect: (id) => {
                  if (!restoreId) {
                    setSelectedId(id)
                  }
                },
              }}
            />
          </section>
          <section className="backup-detail">{detail}</section>
        </div>
      )}
      <Modal
        open={isDeleteOpen}
        title={t('backup.deleteTitle')}
        okText={t('backup.delete')}
        okButtonProps={{ danger: true }}
        cancelText={t('common.cancel')}
        onOk={deleteSelected}
        onCancel={() => setIsDeleteOpen(false)}
      >
        {selected ? t('backup.deleteText', { time: when(selected.createdAt) }) : null}
      </Modal>
      <Modal
        open={isPolicyOpen}
        title={t('backup.policyTitle', { name: game.name })}
        footer={null}
        onCancel={() => setIsPolicyOpen(false)}
      >
        {settings && draft ? (
          <Form {...SETTING_FORM}>
            <Form.Item label={t('backup.followGlobal')}>
              <Switch
                aria-label={t('backup.followGlobal')}
                checked={mode === 'follow'}
                disabled={isActive}
                onChange={(isFollowing) =>
                  // 取消跟随时从当前显示的全局值开始单独设置。
                  isFollowing
                    ? savePolicy('follow', draft)
                    : savePolicy('custom', settings.defaults)
                }
              />
            </Form.Item>
            {mode === 'follow' ? (
              <>
                <BackupPolicyFields policy={settings.defaults} isDisabled onChange={() => {}} />
                <Form.Item label=" ">
                  <Button
                    type="link"
                    onClick={() => {
                      setIsPolicyOpen(false)
                      onOpenAppSettings()
                    }}
                  >
                    {t('backup.editGlobal')}
                  </Button>
                </Form.Item>
              </>
            ) : (
              <BackupPolicyFields
                policy={draft}
                isDisabled={isActive}
                onChange={(next) => savePolicy('custom', next)}
              />
            )}
          </Form>
        ) : null}
      </Modal>
    </div>
  )
}
