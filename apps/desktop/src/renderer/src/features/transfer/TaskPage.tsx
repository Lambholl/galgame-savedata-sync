import { useState } from 'react'
import { Button, Card, Empty, Space, Tag } from 'antd'
import type { LibraryGame, LibraryPeer } from '@savedata-sync/shared'
import type { DesktopCopySummary, DesktopRestoreSummary } from '../../../../bridge/sync-bridge.ts'
import { SyncCopyDetails } from './SyncCopyDetails.tsx'
import { RestoreDetails } from '../backup/RestoreDetails.tsx'
import { syncTaskPreview, useT } from '@savedata-sync/shared/ui'
import { restoreStateTitle } from './sync-display.ts'
import { formatShortDateTime } from '@savedata-sync/shared'

/** 一个游戏的传输详情页：显示所选或最近一次复制或恢复，以及历史记录。 */
export function TaskPage({
  initialCopyId,
  initialRestoreId,
  projectId,
  copies,
  restores,
  games,
  peers,
  isActive,
  onChanged,
  onOpenBackup,
  onRescan,
}: {
  readonly initialCopyId: string | null
  readonly initialRestoreId: string | null
  readonly projectId: string | null
  readonly copies: readonly DesktopCopySummary[]
  readonly restores: readonly DesktopRestoreSummary[]
  readonly games: readonly LibraryGame[]
  readonly peers: readonly LibraryPeer[]
  readonly isActive: boolean
  readonly onChanged: () => void
  /** shownCopyId 是页面正在显示的那次传输，返回时回到它。 */
  readonly onOpenBackup: (projectId: string, shownCopyId: string | null) => void
  /**
   * 用一次传输的游戏、设备和方向重新比较；isUpload 为 true 表示从该设备复制到本机。
   * shownCopyId 是页面正在显示的那次传输，返回时回到它。
   */
  readonly onRescan: (
    projectId: string,
    peerId: string,
    isUpload: boolean,
    shownCopyId: string | null,
  ) => void
}): React.JSX.Element {
  const t = useT()
  const [copyId, setCopyId] = useState<string | null>(initialCopyId),
    [restoreId, setRestoreId] = useState<string | null>(initialRestoreId)
  // 默认显示最近一次传输；点历史记录切换。
  const copy = copies.find((item) => item.jobId === copyId) ?? copies[copies.length - 1] ?? null
  function backup(projectId: string): void {
    setRestoreId(null)
    onOpenBackup(projectId, copy?.jobId ?? null)
  }
  return (
    // 详情放在居中的窄栏里，结构与移动端相同。
    <div className="task-page">
      {!copies.length && !restores.length && (
        <Empty
          description={
            projectId
              ? `${games.find((item) => item.id === projectId)?.name ?? t('common.unknown')} · ${t('game.noTask')}`
              : t('task.none')
          }
        />
      )}
      {copy ? (
        <SyncCopyDetails
          key={copy.jobId}
          task={copy}
          games={games}
          peers={peers}
          onOpenBackup={backup}
          onRescan={(rescanProjectId, peerId, isUpload) =>
            onRescan(rescanProjectId, peerId, isUpload, copy.jobId)
          }
          onChanged={onChanged}
        />
      ) : null}
      {copies.length > 1 && (
        <section className="task-history">
          <h2>{t('task.history')}</h2>
          {[...copies].reverse().map((item) => (
            <button
              type="button"
              key={item.jobId}
              className={`task-history-row ss-pressable${item.jobId === copy?.jobId ? ' is-current' : ''}`}
              onClick={() => setCopyId(item.jobId)}
            >
              <span>
                {games.find((game) => game.id === item.projectId)?.name ?? t('common.unknown')}
                <small>
                  {item.role === 'receiver'
                    ? `${peers.find((peer) => peer.device.id === item.peerId)?.device.name ?? t('common.unknown')} → ${t('transfer.local')}`
                    : `${t('transfer.local')} → ${peers.find((peer) => peer.device.id === item.peerId)?.device.name ?? t('common.unknown')}`}{' '}
                  · {formatShortDateTime(item.updatedAt)}
                </small>
              </span>
              <Tag>{syncTaskPreview(item, t).status}</Tag>
            </button>
          ))}
        </section>
      )}
      {[...restores].reverse().map((item) => (
        <Card
          key={item.restoreId}
          title={`${games.find((game) => game.id === item.projectId)?.name ?? t('common.unknown')} · ${t('backup.restoreTask')}`}
          extra={<Tag>{restoreStateTitle(t, item)}</Tag>}
        >
          <Space orientation="vertical" className="library-full">
            <span>{formatShortDateTime(item.updatedAt)}</span>
            {item.hasCleanupError ? <span>{t('task.cleanupFailed')}</span> : null}
            <Button onClick={() => setRestoreId(item.restoreId)}>{t('backup.openRestore')}</Button>
          </Space>
        </Card>
      ))}
      {restoreId ? (
        <RestoreDetails
          key={restoreId}
          restoreId={restoreId}
          gameName={
            games.find(
              (game) =>
                game.id === restores.find((item) => item.restoreId === restoreId)?.projectId,
            )?.name ?? t('common.unknown')
          }
          sourceName={t('backup.list')}
          isActive={isActive}
          onClose={() => {
            setRestoreId(null)
            onChanged()
          }}
          onChanged={onChanged}
          onOpenBackup={backup}
        />
      ) : null}
    </div>
  )
}
