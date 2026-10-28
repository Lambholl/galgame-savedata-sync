import { useEffect, useRef, useState } from 'react'
import { Button, Switch } from 'antd-mobile'
import type { LibraryGame } from '@savedata-sync/shared'
import type { Confirmation } from '../../app/navigation-types'
import type {
  MobileBackupDetails,
  MobileRestoreDetails,
  MobileSyncAdapter,
} from '../../platform/sync-adapter'
import { Panel } from '../../components/Panel'
import { displayBytes, displayTime } from '../transfer/display'
import { SyncOutcomeView, SyncPlanView } from '../transfer/SyncPlanView'

/** 本机备份设置和恢复：准备只读预览，确认执行时始终保护被覆盖的当前内容。 */
export function BackupPage({
  sync,
  game,
  restore,
  isDisabled,
  onConfirm,
  onChanged,
  onSettings,
}: {
  readonly sync: MobileSyncAdapter
  readonly game: LibraryGame
  readonly restore: MobileRestoreDetails | null
  readonly isDisabled: boolean
  readonly onConfirm: (confirmation: Confirmation) => void
  readonly onChanged: () => void
  readonly onSettings: () => void
}): React.JSX.Element {
  const [details, setDetails] = useState<MobileBackupDetails | null>(null)
  const [error, setError] = useState('')
  const [isBusy, setIsBusy] = useState(false)
  const [version, setVersion] = useState(0)
  const operating = useRef(false)
  const current = restore?.state.projectId === game.id ? restore : null
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
          setError(cause instanceof Error ? cause.message : '读取备份失败。')
        }
      })
    return () => {
      isCurrent = false
    }
  }, [sync, game.id, game.rootId, version, state?.status])
  const shouldBackup =
    details?.info.settings.projects.find(
      (item) => item.projectId === game.id && item.rootId === game.rootId,
    )?.shouldBackup ?? true
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
        setError(cause instanceof Error ? cause.message : '备份操作失败。')
        onChanged()
      })
      .finally(() => {
        operating.current = false
        setIsBusy(false)
      })
  }
  function preference(isEnabled: boolean): void {
    if (isEnabled) {
      run(() => sync.setBackup(game.id, true))
      return
    }
    onConfirm({
      title: '关闭覆盖前备份',
      text: '关闭后，这个项目收到复制时会直接覆盖文件，本次旧内容无法从备份找回。已有备份继续保留，手工恢复仍会保护当前内容。',
      okType: 'danger',
      work: async () => {
        await sync.setBackup(game.id, false)
        reload()
      },
    })
  }
  function prepare(backupId: string): void {
    run(async () => {
      if (restore) {
        await sync.releaseRestore(restore.state.restoreId)
      }
      await sync.prepareRestore(game.id, backupId)
    })
  }
  function execute(): void {
    if (!state || !plan?.canExecute) {
      return
    }
    const id = state.restoreId
    onConfirm({
      title: '恢复本机备份',
      text: '按本次预览恢复备份包含的文件，其他内容保留。覆盖前会另存当前内容，请先退出使用该存档的游戏。',
      work: async () => {
        await sync.executeRestore(id)
        reload()
      },
    })
  }
  return (
    <>
      {error && (
        <div className="notice notice-error" role="alert">
          <p>{error}</p>
          <Button disabled={isBusy} onClick={reload}>
            重新读取备份
          </Button>
          <Button disabled={isLocked} onClick={onSettings}>
            目录设置
          </Button>
        </div>
      )}
      <Panel title="本机备份设置">
        <div className="rule-row">
          <div>
            覆盖前备份<small>接收复制时使用，默认开启；最近保留 3 次。</small>
          </div>
          <Switch
            checked={shouldBackup}
            disabled={isLocked || !details}
            onChange={preference}
            aria-label="覆盖前备份"
          />
        </div>
        {details && (
          <>
            <p className="sync-path">保存位置：{details.info.displayPath}</p>
            <p className="muted">清除应用数据、卸载应用或手工删除备份文件会丢失这些备份。</p>
          </>
        )}
      </Panel>
      <Panel title="可恢复备份">
        {!details ? (
          <p>正在读取备份；读取失败时可在上方重试。</p>
        ) : details.listing.backups.length ? (
          details.listing.backups.map((backup) => (
            <article className="sync-entry" key={backup.backupId}>
              <strong>{displayTime(backup.createdAt)}</strong>
              <span>
                {backup.reason === 'restore' ? '恢复前保护' : '复制前保护'} · {backup.fileCount}{' '}
                个文件 · {displayBytes(backup.totalFileBytes)}
              </span>
              <Button disabled={isLocked} onClick={() => prepare(backup.backupId)}>
                预览恢复
              </Button>
            </article>
          ))
        ) : (
          <p>还没有备份；需要覆盖旧内容时才产生备份轮次。</p>
        )}
        <Button disabled={isBusy} onClick={reload}>
          刷新备份与任务
        </Button>
        {details && details.listing.backups.length > 3 && (
          <Button disabled={isLocked} onClick={() => run(() => sync.rotateBackups(game.id))}>
            重试保留最近 3 次
          </Button>
        )}
        {details?.listing.incomplete.map((id) => (
          <article className="sync-entry" key={id}>
            <span>未完成的备份：{id}</span>
            <Button
              disabled={isLocked}
              onClick={() =>
                onConfirm({
                  title: '清理未完成备份',
                  text: '删除这份未完成备份的自有残留文件，有效备份继续保留。',
                  work: async () => {
                    await sync.cleanupBackup(game.id, id)
                    reload()
                  },
                })
              }
            >
              清理这份残留
            </Button>
          </article>
        ))}
      </Panel>
      {current && (
        <Panel title="本次恢复">
          <p>
            {
              {
                preparing: '正在核对备份并扫描当前内容',
                ready: '预览已准备，请确认',
                running: '正在保护并恢复当前文件',
                succeeded: '恢复已完成',
                failed: '恢复失败',
                cancelled: '恢复已取消',
              }[current.state.status]
            }
          </p>
          {state?.error && <p className="notice notice-error">{state.error.message}</p>}
          {state &&
            (state.status === 'preparing' ||
              state.status === 'running' ||
              state.status === 'ready') && (
              <Button
                disabled={isBusy}
                onClick={() => run(() => sync.cancelRestore(state.restoreId))}
              >
                取消本次恢复
              </Button>
            )}
          {state?.result?.cleanupError && (
            <Button
              disabled={isBusy || state.status === 'running'}
              onClick={() => run(() => sync.cleanupRestore())}
            >
              重试恢复清理
            </Button>
          )}
          {state && state.status !== 'preparing' && state.status !== 'running' && (
            <Button
              disabled={isBusy}
              onClick={() => run(() => sync.releaseRestore(state.restoreId))}
            >
              关闭本次恢复记录
            </Button>
          )}
        </Panel>
      )}
      {plan && (
        <>
          <SyncPlanView
            key={plan.planId}
            plan={plan}
            sourceLabel="本机已验证备份"
            targetLabel={`本机手机 · ${details?.root.rootId === plan.target.rootId ? (details.root.displayPath ?? details.root.displayName) : '本次记录的存档目录已变更'}`}
          />
          {state?.status === 'ready' && (
            <Button
              block
              color="primary"
              disabled={isLocked || !plan.canExecute || game.rootId !== state.rootId}
              onClick={execute}
            >
              确认恢复
            </Button>
          )}
        </>
      )}
      {state?.result && <SyncOutcomeView key={state.restoreId} result={state.result} />}
    </>
  )
}
