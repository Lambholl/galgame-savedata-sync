import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Empty, Modal, Select, Space, Table } from 'antd'
import { unwrap } from '@savedata-sync/shared'
import type {
  DirectoryReference,
  LibraryGame,
  SyncBackupManifest,
  SyncBackupFile,
} from '@savedata-sync/shared'
import type {
  DesktopBackupInfo,
  DesktopBackupList,
  DesktopBackupSummary,
} from '../../../../bridge/backup-bridge.ts'
import { desktopBackups, desktopSync } from '../../platform/sync-adapter.ts'
import { displayBytes, displayTime } from '../../components/display.ts'
import { BackupPreference } from './BackupPreference.tsx'
import { RestoreDetails } from './RestoreDetails.tsx'

/** 只读取所选项目和目录的私有备份；恢复先准备固定计划，再由用户确认写入。 */
export function BackupPage({
  games,
  roots,
  game,
  rootId,
  isActive,
  hasRunningWork,
  onSelectGame,
  onOpenSettings,
  onChanged,
}: {
  readonly games: readonly LibraryGame[]
  readonly roots: readonly DirectoryReference[]
  readonly game: LibraryGame | null
  readonly rootId: string | null
  readonly isActive: boolean
  readonly hasRunningWork: boolean
  readonly onSelectGame: (id: string) => void
  readonly onOpenSettings: () => void
  readonly onChanged: () => void
}): React.JSX.Element {
  const [info, setInfo] = useState<DesktopBackupInfo | null>(null),
    [listing, setListing] = useState<DesktopBackupList | null>(null),
    [isLoading, setIsLoading] = useState(true),
    [isBusy, setIsBusy] = useState(false),
    [error, setError] = useState(''),
    [readError, setReadError] = useState(''),
    [version, setVersion] = useState(0)
  const [selected, setSelected] = useState<DesktopBackupSummary | null>(null),
    [manifest, setManifest] = useState<SyncBackupManifest | null>(null),
    [isReading, setIsReading] = useState(false),
    [manifestError, setManifestError] = useState('')
  const [restoreId, setRestoreId] = useState<string | null>(null),
    [isRestoreOpen, setIsRestoreOpen] = useState(false),
    [isCleanupOpen, setIsCleanupOpen] = useState(false)
  const isCurrent = useRef(true),
    manifestVersion = useRef(0)
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
  const root = roots.find((item) => item.rootId === rootId),
    rootLabel = root?.displayPath ?? root?.displayName ?? '目录记录暂不可用'
  const isCurrentRoot = Boolean(game && rootId && game.rootId === rootId)
  const projectId = game?.id ?? null
  useEffect(() => {
    let hasResult = true
    setIsLoading(true)
    setReadError('')
    setListing(null)
    async function read(): Promise<void> {
      const api = desktopBackups(),
        details = unwrap(await api.read())
      const values = projectId && rootId ? unwrap(await api.list(projectId, rootId)) : null
      if (hasResult) {
        setInfo(details)
        setListing(values)
      }
    }
    void read()
      .catch((cause: unknown) => {
        if (hasResult) {
          setReadError(cause instanceof Error ? cause.message : '备份读取失败。')
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
  }, [projectId, rootId, version])
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
          setError(cause instanceof Error ? cause.message : '备份操作失败。')
        }
      })
      .finally(() => {
        if (isCurrent.current) {
          setIsBusy(false)
          refresh()
        }
      })
  }
  function view(item: DesktopBackupSummary): void {
    if (!game || !rootId) {
      return
    }
    const current = ++manifestVersion.current
    setSelected(item)
    setManifest(null)
    setManifestError('')
    setIsReading(true)
    async function read(): Promise<void> {
      const value = unwrap(
        await desktopBackups().manifest(item.projectId, item.rootId, item.backupId),
      )
      if (isCurrent.current && current === manifestVersion.current) {
        setManifest(value)
      }
    }
    void read()
      .catch((cause: unknown) => {
        if (isCurrent.current && current === manifestVersion.current) {
          setManifestError(cause instanceof Error ? cause.message : '备份详情读取失败。')
        }
      })
      .finally(() => {
        if (isCurrent.current && current === manifestVersion.current) {
          setIsReading(false)
        }
      })
  }
  function prepare(item: DesktopBackupSummary): void {
    run(async () => {
      const api = desktopSync()
      if (restoreId) {
        const previous = await api.restoreState(restoreId)
        if (
          previous.status === 'success' &&
          ['ready', 'preparing'].includes(previous.value.status)
        ) {
          let cancelled = unwrap(await api.cancelRestore(restoreId))
          for (let index = 0; index < 100 && cancelled.isWorking; index++) {
            await new Promise((resolve) => setTimeout(resolve, 50))
            cancelled = unwrap(await api.restoreState(restoreId))
          }
          if (cancelled.isWorking) {
            throw new Error('上次准备尚未结束，请稍后重新预览。')
          }
          if (cancelled.cleanupError) {
            throw new Error(cancelled.cleanupError.message)
          }
          unwrap(await api.releaseRestore(restoreId))
        }
      }
      const next = unwrap(await api.prepareRestore(item.projectId, item.rootId, item.backupId))
      if (isCurrent.current) {
        setRestoreId(next.restoreId)
        setIsRestoreOpen(true)
      }
    })
  }
  function cleanup(): void {
    if (!game || !rootId) {
      return
    }
    const ids = [...(listing?.incomplete ?? [])]
    run(async () => {
      for (const id of ids) {
        unwrap(await desktopBackups().cleanupIncomplete(game.id, rootId, id))
      }
      setIsCleanupOpen(false)
    })
  }
  return (
    <>
      <Card title="选择本机游戏">
        <Select
          className="library-full"
          aria-label="查看游戏备份"
          placeholder="选择游戏"
          value={game?.id ?? null}
          options={games.map((item) => ({ value: item.id, label: item.name }))}
          onChange={onSelectGame}
        />
      </Card>
      {game && rootId ? (
        <>
          <Card title={isCurrentRoot ? '本机目录与备份设置' : '原目录备份'}>
            <p className="library-directory-path">{rootLabel}</p>
            {isCurrentRoot ? (
              <BackupPreference
                key={`${game.id}/${rootId}`}
                projectId={game.id}
                rootId={rootId}
                rootLabel={rootLabel}
                isDisabled={isActive}
              />
            ) : (
              <Alert
                showIcon
                type="info"
                title="这是之前目录的备份。恢复前请在目录设置中切回这个目录。"
              />
            )}
            {!isCurrentRoot && (
              <Button onClick={() => onSelectGame(game.id)}>查看当前目录备份</Button>
            )}
            <Button onClick={onOpenSettings}>目录设置</Button>
          </Card>
          <Card
            title="完整备份"
            loading={isLoading}
            extra={
              <Button disabled={isBusy || isLoading} onClick={refresh}>
                刷新备份
              </Button>
            }
          >
            <div className="library-stack">
              {(error || readError) && <Alert showIcon type="error" title={error || readError} />}
              {listing && listing.backups.length > 0 && (
                <Table<DesktopBackupSummary>
                  size="small"
                  dataSource={[...listing.backups]}
                  rowKey="backupId"
                  pagination={{ defaultPageSize: 10, hideOnSinglePage: true }}
                  scroll={{ x: 600 }}
                  columns={[
                    {
                      title: '备份时间',
                      key: 'time',
                      render: (_, item) => displayTime(item.createdAt),
                    },
                    {
                      title: '保护时机',
                      key: 'reason',
                      render: (_, item) => (item.reason === 'copy' ? '同步覆盖前' : '本机恢复前'),
                    },
                    {
                      title: '文件',
                      key: 'files',
                      render: (_, item) =>
                        `${item.fileCount} 个 · ${displayBytes(item.totalFileBytes)}`,
                    },
                    {
                      title: '操作',
                      key: 'actions',
                      render: (_, item) => (
                        <Space wrap>
                          <Button
                            size="small"
                            disabled={isBusy || isReading}
                            onClick={() => view(item)}
                          >
                            查看内容
                          </Button>
                          <Button
                            size="small"
                            disabled={isBusy || !isCurrentRoot}
                            onClick={() => prepare(item)}
                          >
                            预览恢复
                          </Button>
                        </Space>
                      ),
                    },
                  ]}
                />
              )}
              {!isLoading && !error && !readError && listing?.backups.length === 0 && (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="这个目录还没有完整备份" />
              )}
              {listing && listing.backups.length > 3 && (
                <p>
                  当前保留 {listing.backups.length}{' '}
                  次完整备份。操作结束后可重试整理，正在使用的备份会继续保留。
                </p>
              )}
              <Space wrap>
                <Button
                  disabled={isBusy || hasRunningWork}
                  onClick={() =>
                    run(async () => {
                      unwrap(await desktopBackups().rotate(game.id, rootId))
                    })
                  }
                >
                  整理到最近 3 次
                </Button>
                {Boolean(listing?.incomplete.length) && (
                  <Button
                    disabled={isBusy || hasRunningWork}
                    onClick={() => setIsCleanupOpen(true)}
                  >
                    清理未完成备份（{listing?.incomplete.length}）
                  </Button>
                )}
              </Space>
            </div>
          </Card>
        </>
      ) : (
        <Empty description={game ? '请先为这个游戏选择本机存档目录' : '选择游戏后查看本机备份'}>
          {game && <Button onClick={onOpenSettings}>目录设置</Button>}
        </Empty>
      )}
      {info && (
        <Card size="small" title="本机备份位置">
          <p className="library-directory-path">{info.displayPath}</p>
        </Card>
      )}
      <Modal
        open={selected !== null}
        title={selected ? `备份内容 · ${displayTime(selected.createdAt)}` : '备份内容'}
        footer={null}
        width={900}
        onCancel={() => {
          manifestVersion.current++
          setSelected(null)
          setIsReading(false)
        }}
      >
        {manifestError && <Alert showIcon type="error" title={manifestError} />}
        <Table<SyncBackupFile>
          size="small"
          loading={isReading}
          dataSource={[...(manifest?.files ?? [])]}
          rowKey="fileId"
          pagination={{ defaultPageSize: 20, hideOnSinglePage: true }}
          columns={[
            {
              title: '相对位置',
              key: 'path',
              render: (_, item) => (
                <span className="library-sync-path">{item.path.join(' / ')}</span>
              ),
            },
            { title: '文件大小', key: 'size', render: (_, item) => displayBytes(item.sizeBytes) },
            { title: '原修改时间', key: 'time', render: (_, item) => displayTime(item.modifiedAt) },
          ]}
        />
      </Modal>
      <Modal
        open={isRestoreOpen && restoreId !== null}
        title="本机恢复"
        footer={null}
        width={1000}
        destroyOnHidden
        onCancel={() => {
          setIsRestoreOpen(false)
          refresh()
        }}
      >
        {restoreId && (
          <RestoreDetails
            key={restoreId}
            restoreId={restoreId}
            games={games}
            roots={roots}
            isActive={isActive}
            onNewTask={setRestoreId}
            onChanged={refresh}
          />
        )}
      </Modal>
      <Modal
        open={isCleanupOpen}
        title="清理本目录未完成的备份"
        okText="清理残留"
        cancelText="保留"
        okButtonProps={{ danger: true, disabled: hasRunningWork }}
        cancelButtonProps={{ disabled: isBusy }}
        confirmLoading={isBusy}
        mask={{ closable: !isBusy }}
        closable={!isBusy}
        keyboard={!isBusy}
        onCancel={() => {
          if (!isBusy) {
            setIsCleanupOpen(false)
          }
        }}
        onOk={cleanup}
      >
        <p className="library-directory-path">{rootLabel}</p>
        <p>将清理这个目录下尚未提交或已淘汰的备份残留，完整备份和存档文件继续保留。</p>
        {error && <Alert showIcon type="error" title={error} />}
      </Modal>
    </>
  )
}
