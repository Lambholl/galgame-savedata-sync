import { useState } from 'react'
import { Button, Card, Empty, Modal, Space, Tag } from 'antd'
import type { LibraryGame, LibraryPeer, TransferTask } from '@savedata-sync/shared'
import type { DesktopCopySummary, DesktopRestoreSummary } from '../../../../bridge/sync-bridge.ts'
import { TaskView } from './TaskView.tsx'
import { SyncCopyDetails } from './SyncCopyDetails.tsx'
import { RestoreDetails } from '../backup/RestoreDetails.tsx'
import { useT } from '@savedata-sync/shared/ui'
import { restoreStateTitle, syncStateTitle } from './sync-display.ts'
import { displayTime } from '../../components/display.ts'

export function TaskPage({
  tasks,
  copies,
  restores,
  games,
  peers,
  isActive,
  isBusy,
  onCancel,
  onCleanup,
  onChanged,
  onOpenBackup,
  onRescan,
}: {
  readonly tasks: readonly TransferTask[]
  readonly copies: readonly DesktopCopySummary[]
  readonly restores: readonly DesktopRestoreSummary[]
  readonly games: readonly LibraryGame[]
  readonly peers: readonly LibraryPeer[]
  readonly isActive: boolean
  readonly isBusy: boolean
  readonly onCancel: (id: string) => void
  readonly onCleanup: () => void
  readonly onChanged: () => void
  readonly onOpenBackup: (projectId: string, rootId: string) => void
  readonly onRescan: (projectId: string, peerId: string) => void
}): React.JSX.Element {
  const t = useT()
  const [copyId, setCopyId] = useState<string | null>(null),
    [restoreId, setRestoreId] = useState<string | null>(null)
  // 默认显示最近一次传输；点历史记录切换。
  const copy = copies.find((item) => item.jobId === copyId) ?? copies[copies.length - 1] ?? null
  function backup(projectId: string, rootId: string): void {
    setRestoreId(null)
    onOpenBackup(projectId, rootId)
  }
  return (
    <>
      {!tasks.length && !copies.length && !restores.length && (
        <Empty description={t('task.none')} />
      )}
      {copy && (
        <SyncCopyDetails
          key={copy.jobId}
          task={copy}
          games={games}
          peers={peers}
          onOpenBackup={backup}
          onRescan={onRescan}
          onChanged={onChanged}
        />
      )}
      {copies.length > 1 && (
        <section className="task-history">
          <h2>{t('task.history')}</h2>
          {[...copies].reverse().map((item) => (
            <button
              type="button"
              key={item.jobId}
              className={`task-history-row${item.jobId === copy?.jobId ? ' is-current' : ''}`}
              onClick={() => setCopyId(item.jobId)}
            >
              <span>
                {games.find((game) => game.id === item.projectId)?.name ?? t('common.unknown')}
                <small>
                  {item.direction === 'android-to-windows'
                    ? `${peers.find((peer) => peer.device.id === item.peerId)?.device.name ?? t('common.unknown')} → ${t('transfer.local')}`
                    : `${t('transfer.local')} → ${peers.find((peer) => peer.device.id === item.peerId)?.device.name ?? t('common.unknown')}`}{' '}
                  · {displayTime(item.updatedAt)}
                </small>
              </span>
              <Tag>{syncStateTitle(item)}</Tag>
            </button>
          ))}
        </section>
      )}
      {[...restores].reverse().map((item) => (
        <Card
          key={item.restoreId}
          title={`${games.find((game) => game.id === item.projectId)?.name ?? '已记录的游戏'} · 本机恢复`}
          extra={<Tag>{restoreStateTitle(item)}</Tag>}
        >
          <Space orientation="vertical" className="library-full">
            <span>{displayTime(item.updatedAt)}</span>
            {item.hasCleanupError && <span>有资源待清理</span>}
            <Button onClick={() => setRestoreId(item.restoreId)}>查看恢复详情</Button>
          </Space>
        </Card>
      ))}
      {tasks.length > 0 && (
        <TaskView tasks={tasks} isBusy={isBusy} onCancel={onCancel} onCleanup={onCleanup} />
      )}
      <Modal
        open={restoreId !== null}
        title="本机恢复详情"
        footer={null}
        width={1000}
        destroyOnHidden
        onCancel={() => {
          setRestoreId(null)
          onChanged()
        }}
      >
        {restoreId && (
          <RestoreDetails
            key={restoreId}
            restoreId={restoreId}
            sourceName={t('backup.list')}
            isActive={isActive}
            onClose={() => {
              setRestoreId(null)
              onChanged()
            }}
            onChanged={onChanged}
            onOpenBackup={backup}
          />
        )}
      </Modal>
    </>
  )
}
