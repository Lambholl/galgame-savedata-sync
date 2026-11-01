import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button, Empty, Form, Modal, Switch, Table } from 'antd'
import { HistoryOutlined } from '@ant-design/icons'
import {
  formatBytes,
  formatDateTime,
  formatShortDateTime,
  resolveBackupPolicy,
  unwrap,
} from '@savedata-sync/shared'
import type {
  DirectoryReference,
  LibraryGame,
  SyncBackupFile,
  SyncBackupManifest,
  SyncBackupPolicy,
} from '@savedata-sync/shared'
import type { DesktopBackupInfo, DesktopBackupList } from '../../../../bridge/backup-bridge.ts'
import { BackupPolicyBlock, BackupTimeline, useLocale, useT } from '@savedata-sync/shared/ui'
import { desktopBackups, desktopSync } from '../../platform/sync-adapter.ts'
import { SETTING_FORM } from '../settings/setting-form.ts'
import { BackupPolicyFields } from './BackupPolicyFields.tsx'
import { RestoreDetails } from './RestoreDetails.tsx'

type PolicyMode = 'follow' | 'custom'

/**
 * 备份与恢复：从游戏进入，顶部一条备份策略；左侧备份时间线，右侧显示所选备份里的文件，
 * “恢复此备份”在右侧原地切换为恢复预览，确认后在原处显示结果。
 */
export function BackupPage({
  roots,
  game,
  rootId,
  isActive,
  hasRunningWork,
  onOpenSettings,
  onOpenAppSettings,
  onChanged,
}: {
  readonly roots: readonly DirectoryReference[]
  readonly game: LibraryGame | null
  /** 要查看的目录；可能是游戏之前用过的目录。 */
  readonly rootId: string | null
  readonly isActive: boolean
  readonly hasRunningWork: boolean
  readonly onOpenSettings: () => void
  /** 打开应用设置，修改全局备份设置。 */
  readonly onOpenAppSettings: () => void
  readonly onChanged: () => void
}): React.JSX.Element {
  const t = useT()
  const locale = useLocale()
  const [info, setInfo] = useState<DesktopBackupInfo | null>(null)
  const [listing, setListing] = useState<DesktopBackupList | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isBusy, setIsBusy] = useState(false)
  const [error, setError] = useState('')
  const [version, setVersion] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [manifest, setManifest] = useState<SyncBackupManifest | null>(null)
  const [isReading, setIsReading] = useState(false)
  const [manifestError, setManifestError] = useState('')
  const [restoreId, setRestoreId] = useState<string | null>(null)
  const [isPolicyOpen, setIsPolicyOpen] = useState(false)
  const [mode, setMode] = useState<PolicyMode>('follow')
  const [draft, setDraft] = useState<SyncBackupPolicy | null>(null)
  const isCurrent = useRef(true)
  const saving = useRef(Promise.resolve())
  const manifestVersion = useRef(0)
  const invalidateManifest = useCallback(() => {
    manifestVersion.current++
  }, [])
  useEffect(() => {
    isCurrent.current = true
    return () => {
      isCurrent.current = false
      invalidateManifest()
    }
  }, [invalidateManifest])
  const isCurrentRoot = Boolean(game && rootId && game.rootId === rootId)
  const projectId = game?.id ?? null
  useEffect(() => {
    let hasResult = true
    setIsLoading(true)
    async function read(): Promise<void> {
      const api = desktopBackups()
      const details = unwrap(await api.read())
      const values = projectId && rootId ? unwrap(await api.list(projectId, rootId)) : null
      if (hasResult) {
        setInfo(details)
        setListing(values)
        setError('')
      }
    }
    void read()
      .catch((cause: unknown) => {
        if (hasResult) {
          setError(cause instanceof Error ? cause.message : t('common.unknown'))
        }
      })
      .finally(() => {
        if (hasResult) {
          setIsLoading(false)
        }
      })
    return () => {
      hasResult = false
    }
  }, [projectId, rootId, version, t])
  const backups = listing?.backups ?? []
  const selected = backups.find((item) => item.backupId === selectedId) ?? backups[0] ?? null
  // 所选备份变化时读取它的文件清单；切换得快时只保留最后一次的结果。
  useEffect(() => {
    if (!selected) {
      setManifest(null)
      return
    }
    const current = ++manifestVersion.current
    setManifest(null)
    setManifestError('')
    setIsReading(true)
    async function read(): Promise<void> {
      if (!selected) {
        return
      }
      const value = unwrap(
        await desktopBackups().manifest(selected.projectId, selected.rootId, selected.backupId),
      )
      if (isCurrent.current && current === manifestVersion.current) {
        setManifest(value)
      }
    }
    void read()
      .catch((cause: unknown) => {
        if (isCurrent.current && current === manifestVersion.current) {
          setManifestError(cause instanceof Error ? cause.message : t('common.unknown'))
        }
      })
      .finally(() => {
        if (isCurrent.current && current === manifestVersion.current) {
          setIsReading(false)
        }
      })
  }, [selected, t])
  function refresh(): void {
    setVersion((value) => value + 1)
    onChanged()
  }
  function run(work: () => Promise<void>): void {
    if (isBusy) {
      return
    }
    setIsBusy(true)
    setError('')
    void work()
      .catch((cause: unknown) => {
        if (isCurrent.current) {
          setError(cause instanceof Error ? cause.message : t('common.unknown'))
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
  const policy = settings && resolveBackupPolicy(settings, game.id, rootId)
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
    if (!rootId || !game) {
      return
    }
    const projectId = game.id
    const root = rootId
    setMode(nextMode)
    setDraft(nextDraft)
    setError('')
    const next = nextMode === 'custom' ? nextDraft : null
    saving.current = saving.current
      .then(async () => {
        unwrap(await desktopBackups().setPreference(projectId, root, next))
      })
      .catch((cause: unknown) => {
        if (isCurrent.current) {
          setError(cause instanceof Error ? cause.message : t('common.unknown'))
        }
      })
      .finally(() => {
        if (isCurrent.current) {
          refresh()
        }
      })
  }
  function prepare(): void {
    if (!selected) {
      return
    }
    const item = selected
    run(async () => {
      const next = unwrap(
        await desktopSync().prepareRestore(item.projectId, item.rootId, item.backupId),
      )
      if (isCurrent.current) {
        setRestoreId(next.restoreId)
      }
    })
  }
  const incomplete = listing?.incomplete ?? []
  const when = (value: number): string => formatShortDateTime(value, locale, Date.now())
  const root = roots.find((item) => item.rootId === rootId)
  let detail: React.ReactNode
  if (restoreId) {
    detail = (
      <RestoreDetails
        key={restoreId}
        restoreId={restoreId}
        sourceName={selected ? when(selected.createdAt) : t('backup.list')}
        isActive={isActive}
        onClose={() => {
          setRestoreId(null)
          refresh()
        }}
        onChanged={onChanged}
        onOpenBackup={null}
      />
    )
  } else if (selected) {
    detail = (
      <>
        <div className="backup-detail-head">
          <div>
            <h2>{when(selected.createdAt)}</h2>
            <p>
              {t(`backup.reason.${selected.reason}`)} ·{' '}
              {t('backup.files', {
                count: selected.fileCount,
                size: formatBytes(selected.totalFileBytes),
              })}
            </p>
          </div>
          <Button
            type="primary"
            icon={<HistoryOutlined />}
            loading={isBusy}
            disabled={!isCurrentRoot || isActive || hasRunningWork}
            onClick={prepare}
          >
            {t('backup.restoreThis')}
          </Button>
        </div>
        {manifestError && <Alert showIcon type="error" title={manifestError} />}
        <Table<SyncBackupFile>
          size="small"
          loading={isReading}
          dataSource={[...(manifest?.files ?? [])]}
          rowKey="fileId"
          pagination={{ defaultPageSize: 50, hideOnSinglePage: true }}
          columns={[
            {
              title: t('backup.file'),
              key: 'path',
              render: (_, item) => <span className="backup-file">{item.path.join(' / ')}</span>,
            },
            {
              title: t('compare.size'),
              key: 'size',
              align: 'right',
              render: (_, item) => formatBytes(item.sizeBytes),
            },
            {
              title: t('backup.originalModified'),
              key: 'time',
              align: 'right',
              render: (_, item) =>
                item.modifiedAt === null ? '' : formatDateTime(item.modifiedAt, locale),
            },
          ]}
        />
      </>
    )
  } else {
    detail = null
  }
  return (
    <div className="library-stack">
      {policy && (
        <BackupPolicyBlock
          isEnabled={policy.shouldBackup}
          keepCount={policy.keepCount}
          isCustom={policy.isCustom}
          location={info?.displayPath ?? null}
          onEdit={isCurrentRoot && !isActive ? openPolicy : null}
        />
      )}
      {!isCurrentRoot && (
        <Alert
          showIcon
          type="info"
          title={t('backup.oldFolder')}
          description={root?.displayPath ?? root?.displayName}
          action={
            <Button size="small" onClick={onOpenSettings}>
              {t('page.gameSettings')}
            </Button>
          }
        />
      )}
      {error && (
        <Alert
          showIcon
          type="error"
          title={t('backup.readFailed', { message: error })}
          action={
            <Button size="small" onClick={refresh}>
              {t('common.retry')}
            </Button>
          }
        />
      )}
      {incomplete.length > 0 && (
        <Alert
          showIcon
          type="warning"
          title={t('backup.incomplete', { count: incomplete.length })}
          action={
            <Button
              size="small"
              disabled={isBusy || hasRunningWork}
              onClick={() =>
                run(async () => {
                  for (const id of incomplete) {
                    unwrap(await desktopBackups().cleanupIncomplete(game.id, rootId, id))
                  }
                })
              }
            >
              {t('backup.cleanup')}
            </Button>
          }
        />
      )}
      {isLoading && !listing ? null : (
        <div className="backup-columns">
          <section>
            <h3 className="group-title">
              {t('backup.list')}
              {policy && (
                <small>
                  {backups.length} / {policy.keepCount}
                </small>
              )}
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
        open={isPolicyOpen}
        title={t('backup.policyTitle', { name: game.name })}
        footer={null}
        onCancel={() => setIsPolicyOpen(false)}
      >
        {settings && draft && (
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
        )}
      </Modal>
    </div>
  )
}
