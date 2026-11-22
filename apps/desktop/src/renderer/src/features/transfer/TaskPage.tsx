import { useState } from 'react'
import { Empty, Tag } from 'antd'
import { formatShortDateTime } from '@savedata-sync/shared'
import type { LibraryGame, LibraryPeer } from '@savedata-sync/shared'
import { restoreObservationPreview, syncTaskPreview, useT } from '@savedata-sync/shared/ui'
import type { DesktopCopySummary, DesktopRestoreSummary } from '../../../../bridge/sync-bridge.ts'
import { SyncCopyDetails } from './SyncCopyDetails.tsx'
import { SyncRestoreDetails } from './SyncRestoreDetails.tsx'

type TaskSelection =
  { readonly kind: 'copy'; readonly id: string } | { readonly kind: 'restore'; readonly id: string }

type HistoryEntry =
  | { readonly kind: 'copy'; readonly id: string; readonly item: DesktopCopySummary }
  | { readonly kind: 'restore'; readonly id: string; readonly item: DesktopRestoreSummary }

/** 一个游戏的传输与恢复详情页：显示所选或最近一次复制或恢复，以及历史记录。 */
export function TaskPage({
  initialCopyId,
  initialRestoreId,
  projectId,
  copies,
  restores,
  restoreSources,
  games,
  peers,
  onChanged,
  onOpenBackup,
  onRescan,
}: {
  readonly initialCopyId: string | null
  readonly initialRestoreId: string | null
  readonly projectId: string | null
  readonly copies: readonly DesktopCopySummary[]
  readonly restores: readonly DesktopRestoreSummary[]
  /** 恢复任务编号到备份来源名称的映射。 */
  readonly restoreSources: Readonly<Record<string, string>>
  readonly games: readonly LibraryGame[]
  readonly peers: readonly LibraryPeer[]
  readonly onChanged: () => void
  /** shownCopyId 和 shownRestoreId 是页面正在显示的任务，返回时回到它。 */
  readonly onOpenBackup: (
    projectId: string,
    shownCopyId: string | null,
    shownRestoreId: string | null,
  ) => void
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
  const [selection, setSelection] = useState<TaskSelection | null>(() =>
    initialRestoreId
      ? { kind: 'restore', id: initialRestoreId }
      : initialCopyId
        ? { kind: 'copy', id: initialCopyId }
        : null,
  )

  const history: HistoryEntry[] = [
    ...copies.map((item): HistoryEntry => ({ kind: 'copy', id: item.jobId, item })),
    ...restores
      .filter((item) => item.status !== 'preparing' && item.status !== 'ready')
      .map((item): HistoryEntry => ({ kind: 'restore', id: item.restoreId, item })),
  ].sort((a, b) => b.item.updatedAt - a.item.updatedAt)

  const current =
    (selection
      ? history.find((entry) => entry.kind === selection.kind && entry.id === selection.id)
      : null) ??
    history[0] ??
    null

  function openBackup(targetProjectId: string): void {
    onOpenBackup(
      targetProjectId,
      current?.kind === 'copy' ? current.id : null,
      current?.kind === 'restore' ? current.id : null,
    )
  }

  return (
    // 详情放在居中的窄栏里，结构与移动端相同。
    <div className="task-page">
      {history.length === 0 ? (
        <Empty
          description={
            projectId
              ? `${games.find((item) => item.id === projectId)?.name ?? t('common.unknown')} · ${t('game.noTask')}`
              : t('task.none')
          }
        />
      ) : null}
      {current?.kind === 'copy' ? (
        <SyncCopyDetails
          key={`copy:${current.id}`}
          task={current.item}
          games={games}
          peers={peers}
          onOpenBackup={openBackup}
          onRescan={(rescanProjectId, peerId, isUpload) =>
            onRescan(rescanProjectId, peerId, isUpload, current.id)
          }
          onChanged={onChanged}
        />
      ) : null}
      {current?.kind === 'restore' ? (
        <SyncRestoreDetails
          key={`restore:${current.id}`}
          task={current.item}
          sourceName={restoreSources[current.id] ?? null}
          games={games}
          onOpenBackup={openBackup}
          onChanged={onChanged}
        />
      ) : null}
      {history.length > 1 ? (
        <section className="task-history">
          <h2>{t('task.history')}</h2>
          {history.map((entry) => {
            const isSelected = current?.kind === entry.kind && current.id === entry.id
            if (entry.kind === 'copy') {
              const item = entry.item
              const peerName =
                peers.find((peer) => peer.device.id === item.peerId)?.device.name ??
                t('common.unknown')
              return (
                <button
                  type="button"
                  key={`copy:${item.jobId}`}
                  className={`task-history-row ss-pressable${isSelected ? ' is-current' : ''}`}
                  onClick={() => setSelection({ kind: 'copy', id: item.jobId })}
                >
                  <span>
                    {games.find((game) => game.id === item.projectId)?.name ?? t('common.unknown')}
                    <small>
                      {item.role === 'receiver'
                        ? `${peerName} → ${t('transfer.local')}`
                        : `${t('transfer.local')} → ${peerName}`}{' '}
                      · {formatShortDateTime(item.updatedAt)}
                    </small>
                  </span>
                  <Tag>{syncTaskPreview(item, t).status}</Tag>
                </button>
              )
            }
            const item = entry.item
            return (
              <button
                type="button"
                key={`restore:${item.restoreId}`}
                className={`task-history-row ss-pressable${isSelected ? ' is-current' : ''}`}
                onClick={() => setSelection({ kind: 'restore', id: item.restoreId })}
              >
                <span>
                  {games.find((game) => game.id === item.projectId)?.name ?? t('common.unknown')}
                  <small>
                    {restoreSources[item.restoreId] ?? t('backup.list')} → {t('transfer.local')} ·{' '}
                    {formatShortDateTime(item.updatedAt)}
                  </small>
                </span>
                <Tag>{restoreObservationPreview(item, t).status}</Tag>
              </button>
            )
          })}
        </section>
      ) : null}
    </div>
  )
}
