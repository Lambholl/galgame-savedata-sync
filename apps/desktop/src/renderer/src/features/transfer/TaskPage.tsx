import { useState } from 'react'
import { Button, Card, Empty, Modal, Space, Tag } from 'antd'
import type {
  DirectoryReference,
  LibraryGame,
  LibraryPeer,
  TransferTask,
} from '@savedata-sync/shared'
import type { DesktopCopySummary, DesktopRestoreSummary } from '../../../../bridge/sync-bridge.ts'
import { TaskView } from './TaskView.tsx'
import { SyncCopyDetails } from './SyncCopyDetails.tsx'
import { RestoreDetails } from '../backup/RestoreDetails.tsx'
import { restoreStateTitle, syncStateTitle } from './sync-display.ts'
import { displayTime } from '../../components/display.ts'

export function TaskPage({
  tasks,
  copies,
  restores,
  games,
  roots,
  peers,
  isActive,
  isBusy,
  onCancel,
  onCleanup,
  onChanged,
  onOpenBackup,
}: {
  readonly tasks: readonly TransferTask[]
  readonly copies: readonly DesktopCopySummary[]
  readonly restores: readonly DesktopRestoreSummary[]
  readonly games: readonly LibraryGame[]
  readonly roots: readonly DirectoryReference[]
  readonly peers: readonly LibraryPeer[]
  readonly isActive: boolean
  readonly isBusy: boolean
  readonly onCancel: (id: string) => void
  readonly onCleanup: () => void
  readonly onChanged: () => void
  readonly onOpenBackup: (projectId: string, rootId: string) => void
}): React.JSX.Element {
  const [copy, setCopy] = useState<DesktopCopySummary | null>(null),
    [restoreId, setRestoreId] = useState<string | null>(null)
  function backup(projectId: string, rootId: string): void {
    setCopy(null)
    setRestoreId(null)
    onOpenBackup(projectId, rootId)
  }
  return (
    <>
      {!tasks.length && !copies.length && !restores.length && (
        <Empty description="暂无同步或恢复任务" />
      )}
      {[...copies].reverse().map((item) => (
        <Card
          key={item.jobId}
          title={`${games.find((game) => game.id === item.projectId)?.name ?? '同步任务'} · ${item.direction === 'android-to-windows' ? '手机 → 电脑' : '电脑 → 手机'}`}
          extra={<Tag>{syncStateTitle(item)}</Tag>}
        >
          <Space orientation="vertical" className="library-full">
            <span>
              {peers.find((peer) => peer.device.id === item.peerId)?.device.name ?? '已记录的手机'}{' '}
              · {displayTime(item.updatedAt)}
            </span>
            {item.hasCleanupError && <span>有资源待清理</span>}
            <Button onClick={() => setCopy(item)}>查看计划与结果</Button>
          </Space>
        </Card>
      ))}
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
        open={copy !== null}
        title="同步计划与结果"
        footer={null}
        width={1000}
        destroyOnHidden
        onCancel={() => {
          setCopy(null)
          onChanged()
        }}
      >
        {copy && (
          <SyncCopyDetails
            key={copy.jobId}
            task={copy}
            games={games}
            roots={roots}
            peers={peers}
            onOpenBackup={backup}
            onChanged={onChanged}
          />
        )}
      </Modal>
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
            games={games}
            roots={roots}
            isActive={isActive}
            onNewTask={setRestoreId}
            onChanged={onChanged}
            onOpenBackup={backup}
          />
        )}
      </Modal>
    </>
  )
}
