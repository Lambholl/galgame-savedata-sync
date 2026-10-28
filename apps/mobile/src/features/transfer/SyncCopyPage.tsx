import { useEffect, useRef, useState } from 'react'
import { Button } from 'antd-mobile'
import { CaretRightOutlined, RightOutlined } from '@ant-design/icons'
import { syncPlanFromPreview } from '@savedata-sync/shared'
import type {
  DirectoryReference,
  LibraryGame,
  LibraryPeer,
  SyncPreparationPreview,
  SyncPreparationState,
  TransferDirection,
} from '@savedata-sync/shared'
import type { MobileSyncAdapter } from '../../platform/sync-adapter'
import type { MobileLibraryAdapter } from '../../platform/library-types'
import type { Confirmation } from '../../app/navigation-types'
import { ChoiceField } from '../../components/ChoiceField'
import { Panel } from '../../components/Panel'
import { SyncPlanView } from './SyncPlanView'
import { DirectoryPane } from './DirectoryPane'
import { FloatingPageAction } from '../../components/FloatingPageAction'

/** 手机发起两个方向；方向或设备变化后释放旧预览，执行始终引用原生固定计划。 */
export function SyncCopyPage({
  adapter,
  sync,
  game,
  peers,
  localRoot,
  peerId,
  isPlan,
  isDisabled,
  onPeerChange,
  onConfirm,
  onStarted,
  onPlanReady,
  onFailure,
  onSettings,
  onBackup,
}: {
  readonly adapter: MobileLibraryAdapter
  readonly sync: MobileSyncAdapter
  readonly game: LibraryGame
  readonly peers: readonly LibraryPeer[]
  readonly localRoot: DirectoryReference | null
  readonly peerId: string
  readonly isPlan: boolean
  readonly isDisabled: boolean
  readonly onPeerChange: (id: string) => void
  readonly onConfirm: (confirmation: Confirmation) => void
  readonly onStarted: (jobId: string) => void
  readonly onPlanReady: () => void
  readonly onFailure: (message: string) => void
  readonly onSettings: () => void
  readonly onBackup: () => void
}): React.JSX.Element {
  const [direction, setDirection] = useState<TransferDirection>('windows-to-android')
  const [preparation, setPreparation] = useState<SyncPreparationState | null>(null)
  const [preview, setPreview] = useState<SyncPreparationPreview | null>(null)
  const [error, setError] = useState('')
  const [isBusy, setIsBusy] = useState(false)
  const [version, setVersion] = useState(0)
  const operating = useRef(false)
  const peer = peers.find((item) => item.device.id === peerId)
  const remote = peer?.games.find(
    (item) => item.id === game.links.find((link) => link.deviceId === peerId)?.gameId,
  )
  const isPreparing = preparation?.status === 'preparing'
  const preparationId = preparation?.preparationId
  const isLocked = isDisabled || isBusy || isPreparing
  const plan = preview ? syncPlanFromPreview(preview) : null
  const hasChanged =
    preview !== null &&
    (preview.binding.projectId !== game.id ||
      preview.binding.remoteDeviceId !== peerId ||
      preview.binding.localRootId !== game.rootId ||
      preview.binding.remoteRootId !== remote?.root?.rootId ||
      preview.binding.remoteProjectId !== remote?.id)
  useEffect(() => {
    if (!preparationId || !isPreparing) {
      return
    }
    const id = preparationId
    let isCurrent = true
    let timer: ReturnType<typeof setTimeout>
    async function poll(): Promise<void> {
      try {
        const state = await sync.preparation(id)
        const value = state.status === 'ready' ? await sync.preview(id) : null
        if (!isCurrent) {
          return
        }
        setPreparation(state)
        if (value) {
          setPreview(value)
          onPlanReady()
        }
        if (state.status === 'failed') {
          onFailure(state.error?.message ?? '扫描失败，请重试。')
        }
        if (state.status === 'preparing') {
          timer = setTimeout(() => {
            poll().catch(() => setError('读取扫描结果失败。'))
          }, 700)
        }
      } catch (cause) {
        if (isCurrent) {
          setError(cause instanceof Error ? cause.message : '读取扫描结果失败。')
          onFailure(cause instanceof Error ? cause.message : '读取扫描结果失败。')
        }
      }
    }
    poll().catch(() => setError('读取扫描结果失败。'))
    return () => {
      isCurrent = false
      clearTimeout(timer)
    }
  }, [sync, preparationId, isPreparing, version, onPlanReady, onFailure])
  function run(work: () => Promise<void>): void {
    if (operating.current) {
      return
    }
    operating.current = true
    setIsBusy(true)
    setError('')
    work()
      .catch((cause: unknown) => {
        const message = cause instanceof Error ? cause.message : '扫描操作失败。'
        setError(message)
        onFailure(message)
      })
      .finally(() => {
        operating.current = false
        setIsBusy(false)
      })
  }
  async function discard(): Promise<void> {
    if (preparation) {
      await sync.releasePreparation(preparation.preparationId)
    }
    setPreparation(null)
    setPreview(null)
  }
  function scan(): void {
    run(async () => {
      await discard()
      const state = await sync.prepare(game.id, peerId, direction)
      setPreparation(state)
      if (state.status === 'ready') {
        setPreview(await sync.preview(state.preparationId))
        onPlanReady()
      } else if (state.status === 'failed') {
        onFailure(state.error?.message ?? '扫描失败，请重试。')
      }
    })
  }
  function execute(): void {
    if (!plan?.canExecute || !preparation) {
      return
    }
    const id = preparation.preparationId
    onConfirm({
      title: direction === 'android-to-windows' ? '手机 → 电脑' : '电脑 → 手机',
      text: `${game.name}，将向目标写入本次计划。${plan.shouldBackup ? '覆盖前先备份目标旧内容。' : '本次关闭覆盖前备份。'}请先退出使用该存档的游戏。`,
      okType: plan.shouldBackup ? 'primary' : 'danger',
      work: async () => {
        const state = await sync.execute(id)
        onStarted(state.jobId)
      },
    })
  }
  const localLabel = `本机手机 · ${localRoot?.displayPath ?? localRoot?.displayName ?? '未选择目录'}`
  const remoteLabel = `${peer?.device.name ?? '电脑'} · ${remote?.root?.displayPath ?? remote?.root?.displayName ?? '未选择目录'}`
  const planLocalLabel =
    preview?.binding.localRootId === localRoot?.rootId
      ? localLabel
      : '本机手机 · 本次扫描的目录已变更'
  const planRemoteLabel =
    preview?.binding.remoteRootId === remote?.root?.rootId
      ? remoteLabel
      : '电脑 · 本次扫描的目录已变更'
  return (
    <>
      <div hidden={isPlan}>
        <div className="page-stack">
          <Panel>
            <ChoiceField
              label="对端设备"
              value={peerId}
              options={game.links.map((link) => {
                const device = peers.find((item) => item.device.id === link.deviceId)
                return {
                  value: link.deviceId,
                  label: `${device?.device.name ?? '未知设备'} · ${device?.isConnected ? '已连接' : '未连接'}`,
                }
              })}
              isDisabled={isLocked}
              onChange={(id) =>
                run(async () => {
                  await discard()
                  onPeerChange(id)
                })
              }
            />
            <div className="direction-picker" role="group" aria-label="复制方向">
              {(['windows-to-android', 'android-to-windows'] as const).map((value) => (
                <Button
                  key={value}
                  color={direction === value ? 'primary' : 'default'}
                  disabled={isLocked}
                  onClick={() =>
                    run(async () => {
                      await discard()
                      setDirection(value)
                    })
                  }
                >
                  {value === 'windows-to-android' ? '电脑 → 手机' : '手机 → 电脑'}
                </Button>
              ))}
            </div>
          </Panel>
          <div className="dual-directories">
            <DirectoryPane
              key={`local-${game.id}-${localRoot?.rootId ?? ''}`}
              adapter={adapter}
              deviceId={null}
              root={localRoot}
              title="本机手机"
              isSource={direction === 'android-to-windows'}
              isDisabled={isLocked}
              isOnline
            />
            <DirectoryPane
              key={`remote-${game.id}-${peerId}-${remote?.root?.rootId ?? ''}`}
              adapter={adapter}
              deviceId={peerId || null}
              root={remote?.root ?? null}
              title={peer?.device.name ?? '对端电脑'}
              isSource={direction === 'windows-to-android'}
              isDisabled={isLocked}
              isOnline={Boolean(peer?.isConnected)}
            />
          </div>
          <div className="action-row equal">
            <Button disabled={isLocked} onClick={onSettings}>
              目录设置
            </Button>
            <Button disabled={isLocked} onClick={onBackup}>
              本机备份设置
            </Button>
          </div>
          {(error || preparation?.error) && (
            <div className="notice notice-error" role="alert">
              <p>{error || preparation?.error?.message}</p>
              <Button disabled={isBusy} onClick={() => setVersion((value) => value + 1)}>
                重新读取扫描状态
              </Button>
            </div>
          )}
          {isPreparing && (
            <Panel title="正在扫描两端当前内容">
              <p>完成后显示本次计划。</p>
              <Button
                disabled={isBusy}
                onClick={() =>
                  run(async () => {
                    setPreparation(await sync.cancelPreparation(preparation.preparationId))
                  })
                }
              >
                取消扫描
              </Button>
            </Panel>
          )}
          {preparation?.status === 'cancelled' && <p className="notice">扫描已取消。</p>}
        </div>
      </div>
      {isPlan && plan && (
        <>
          {hasChanged && (
            <p className="notice notice-error">项目或目录已变化，请重新扫描并确认。</p>
          )}
          <SyncPlanView
            key={plan.planId}
            plan={plan}
            sourceLabel={direction === 'android-to-windows' ? planLocalLabel : planRemoteLabel}
            targetLabel={direction === 'android-to-windows' ? planRemoteLabel : planLocalLabel}
          />
        </>
      )}
      {isPlan && !plan && <p className="notice">本次计划不可用，请返回传输存档后重新扫描。</p>}
      <FloatingPageAction
        icon={isPlan ? <CaretRightOutlined /> : <RightOutlined />}
        label={isPlan ? '开始' : ''}
        ariaLabel={isPlan ? '开始传输' : '扫描并预览本次变化'}
        isLoading={isBusy || isPreparing}
        isDisabled={
          isLocked ||
          (isPlan
            ? hasChanged ||
              !plan?.canExecute ||
              !plan.entries.some((item) =>
                ['create-file', 'replace-file', 'create-directory'].includes(item.action),
              )
            : !peer?.isConnected || !localRoot || !remote?.root)
        }
        onClick={isPlan ? execute : scan}
      />
    </>
  )
}
