import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Empty } from 'antd'
import { emptyLibrary, isPortableFileName } from '@savedata-sync/shared'
import type { LibraryGame, LibraryPeer } from '@savedata-sync/shared'
import { taskIsActive } from './api.ts'
import type { UiAdapter, UiSnapshot } from './api.ts'
import type { PaneLocation } from './DirectoryPane.tsx'
import { ConfirmationDialog } from './components/ConfirmationDialog.tsx'
import { DeviceEditorDialog } from './components/DeviceEditorDialog.tsx'
import { GameActions } from './components/GameActions.tsx'
import { GameMenu } from './components/GameMenu.tsx'
import { ImportGameDialog } from './components/ImportGameDialog.tsx'
import { LibraryShell } from './components/LibraryShell.tsx'
import { PAGE_TITLES } from './library-types.ts'
import type { BackButtonController, Confirmation, Page } from './library-types.ts'
import { BackupPage } from './pages/BackupPage.tsx'
import { DevicesPage } from './pages/DevicesPage.tsx'
import { GamesPage } from './pages/GamesPage.tsx'
import { GameSettingsPage } from './pages/GameSettingsPage.tsx'
import { SettingsPage } from './pages/SettingsPage.tsx'
import { TaskPage } from './pages/TaskPage.tsx'
import { TransferPage } from './pages/TransferPage.tsx'
import './style.css'

const EMPTY = emptyLibrary()

/** 双端共用控制器；页面只接收本次状态和动作，平台能力由 adapter 注入。 */
export function LibraryApp({
  adapter,
  backButton,
}: {
  readonly adapter: UiAdapter
  readonly backButton?: BackButtonController
}): React.JSX.Element {
  const isMobile = adapter.platform === 'android'
  const [page, setPage] = useState<Page>('games')
  const [snapshot, setSnapshot] = useState<UiSnapshot | null>(null)
  const [error, setError] = useState('')
  const [isBusy, setIsBusy] = useState(false)
  const [gameId, setGameId] = useState('')
  const [peerId, setPeerId] = useState('')
  const [isGameMenuOpen, setIsGameMenuOpen] = useState(false)
  const [isDeviceEditorOpen, setIsDeviceEditorOpen] = useState(false)
  const [editingDeviceId, setEditingDeviceId] = useState<string | null>(null)
  const [deviceName, setDeviceName] = useState('')
  const [deviceAddress, setDeviceAddress] = useState('')
  const [isImportOpen, setIsImportOpen] = useState(false)
  const [importKey, setImportKey] = useState('')
  const [linkPeerId, setLinkPeerId] = useState('')
  const [linkGameId, setLinkGameId] = useState('')
  const [upload, setUpload] = useState(false)
  const [localLocation, setLocalLocation] = useState<PaneLocation | null>(null)
  const [remoteLocation, setRemoteLocation] = useState<PaneLocation | null>(null)
  const [targetNames, setTargetNames] = useState<Readonly<Record<string, string>>>({})
  const [port, setPort] = useState<number | null>(0)
  const [copied, setCopied] = useState('')
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [isDark, setIsDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  )
  const operating = useRef(false)
  const generation = useRef(0)
  const backHandler = useRef<() => boolean>(() => false)
  const invalidate = useCallback(() => {
    generation.current++
  }, [])
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  const refresh = useCallback(async (): Promise<void> => {
    const version = ++generation.current
    const value = await adapter.read()
    if (version === generation.current) {
      snapshotRef.current = value
      setSnapshot(value)
      if (value.warning) {
        setError(value.warning)
      }
    }
  }, [adapter])
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const update = (): void => setIsDark(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    let isCurrent = true
    let timer: ReturnType<typeof setTimeout>
    async function poll(): Promise<void> {
      if (!isCurrent) {
        return
      }
      if (!operating.current && document.visibilityState !== 'hidden') {
        try {
          await refresh()
        } catch (cause) {
          if (isCurrent) {
            setError(cause instanceof Error ? cause.message : '读取应用状态失败。')
          }
        }
      }
      if (isCurrent) {
        timer = setTimeout(() => {
          poll().catch(() => setError('刷新失败，请重试。'))
        }, 1800)
      }
    }
    poll().catch(() => setError('读取应用失败。'))
    return () => {
      isCurrent = false
      invalidate()
      clearTimeout(timer)
    }
  }, [refresh, invalidate])
  useEffect(() => backButton?.subscribe(() => backHandler.current()), [backButton])
  function run(work: () => Promise<void>): void {
    if (operating.current) {
      return
    }
    operating.current = true
    generation.current++
    setIsBusy(true)
    setError('')
    work()
      .then(refresh)
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : '操作失败，请重试。'),
      )
      .finally(() => {
        operating.current = false
        setIsBusy(false)
      })
  }
  const config = snapshot?.config ?? EMPTY
  const game = config.games.find((item) => item.id === gameId) ?? null
  const peers = snapshot?.peers ?? []
  const online = peers.find((item) => item.isConnected) ?? null
  const selectedPeer =
    peers.find(
      (item) => item.device.id === peerId && game?.links.some((link) => link.deviceId === peerId),
    ) ?? null
  const remoteGame = selectedPeer?.games.find(
    (item) => item.id === game?.links.find((link) => link.deviceId === peerId)?.gameId,
  )
  const localRoot = snapshot?.roots.find((item) => item.rootId === game?.rootId) ?? null
  const isActive = snapshot?.tasks.some(taskIsActive) ?? false
  const isDisabled = isBusy || !snapshot
  const isLocalSource = isMobile ? upload : !upload
  const source = isLocalSource ? localLocation : remoteLocation
  const target = isLocalSource ? remoteLocation : localLocation
  const importable = peers
    .filter((item) => item.isConnected)
    .flatMap((peer) =>
      peer.games
        .filter(
          (item) =>
            !config.games.some((value) =>
              value.links.some(
                (link) => link.deviceId === peer.device.id && link.gameId === item.id,
              ),
            ),
        )
        .map((item) => ({ key: `${peer.device.id}/${item.id}`, peer, item })),
    )
  function openGame(item: LibraryGame): void {
    setGameId(item.id)
    setPeerId(item.links.length === 1 ? (item.links[0]?.deviceId ?? '') : '')
    setIsGameMenuOpen(true)
    setLocalLocation(null)
    setRemoteLocation(null)
    setTargetNames({})
  }
  async function saveGame(item: LibraryGame): Promise<void> {
    const current = snapshotRef.current?.config
    if (!current) {
      throw new Error('配置还没有读取完成。')
    }
    await adapter.saveGames(current.games.map((value) => (value.id === item.id ? item : value)))
  }
  function renameGame(value: string): void {
    if (!game) {
      return
    }
    const name = value.trim()
    if (!name) {
      setError('游戏名称不能为空。')
      return
    }
    if (name !== game.name) {
      run(() => saveGame({ ...game, name }))
    }
  }
  function chooseDirectory(isReceive: boolean): void {
    if (!game) {
      return
    }
    if (isReceive) {
      setConfirmation({
        title: '允许接收新文件',
        text: '请选独立测试目录。同名文件会停止接收，真实存档请保持只读。',
        work: async () => {
          const result = await adapter.chooseDirectory(true)
          if (result.status === 'error') {
            throw new Error(result.error.message)
          }
          if (result.status === 'selected') {
            await saveGame({ ...game, rootId: result.directory.rootId })
          }
          setConfirmation(null)
        },
      })
    } else {
      run(async () => {
        const result = await adapter.chooseDirectory(false)
        if (result.status === 'error') {
          throw new Error(result.error.message)
        }
        if (result.status === 'selected') {
          await saveGame({ ...game, rootId: result.directory.rootId })
        }
      })
    }
  }
  function addGame(): void {
    run(async () => {
      const item: LibraryGame = { id: crypto.randomUUID(), name: '新游戏', rootId: null, links: [] }
      await adapter.saveGames([...(snapshotRef.current?.config.games ?? []), item])
      setGameId(item.id)
      setPeerId('')
      setPage('edit')
    })
  }
  function deviceEditor(id: string | null): void {
    const item = config.devices.find((value) => value.id === id)
    setEditingDeviceId(id)
    setDeviceName(item?.name ?? '')
    setDeviceAddress(item?.address ?? '')
    setIsDeviceEditorOpen(true)
  }
  function saveDevice(): void {
    run(async () => {
      if (editingDeviceId) {
        await adapter.device(
          editingDeviceId,
          'rename',
          deviceName.trim(),
          isMobile ? deviceAddress : undefined,
        )
      } else {
        await adapter.connect(deviceAddress)
      }
      setIsDeviceEditorOpen(false)
    })
  }
  function removeDevice(): void {
    if (!editingDeviceId) {
      return
    }
    const deviceId = editingDeviceId
    setConfirmation({
      title: '移除设备',
      text: '移除设备和相关游戏关联，保留存档文件。',
      okType: 'danger',
      work: async () => {
        await adapter.device(deviceId, 'forget')
        setIsDeviceEditorOpen(false)
        setConfirmation(null)
      },
    })
  }
  function copyAddress(address: string): void {
    run(async () => {
      await navigator.clipboard.writeText(address)
      setCopied(address)
    })
  }
  function toggleService(): void {
    const service = snapshot?.service
    if (!service) {
      return
    }
    if (service.isRunning && isActive) {
      setConfirmation({
        title: '停止服务',
        text: '将断开设备，并取消当前传输。',
        work: async () => {
          await adapter.service(false, port ?? 0)
          setConfirmation(null)
        },
      })
    } else {
      run(() => adapter.service(!service.isRunning, port ?? 0))
    }
  }
  function actOnDevice(peer: LibraryPeer): void {
    run(() => adapter.device(peer.device.id, peer.isConnected ? 'disconnect' : 'allow'))
  }
  function go(value: Page): void {
    setIsGameMenuOpen(false)
    setPage(value)
  }
  function changePeer(id: string): void {
    setPeerId(id)
    setLocalLocation(null)
    setRemoteLocation(null)
    setTargetNames({})
    setPage('transfer')
  }
  function changeUpload(isUpload: boolean): void {
    setUpload(isUpload)
    setTargetNames({})
    setPage('transfer')
  }
  function changeLinkPeer(id: string): void {
    setLinkPeerId(id)
    setLinkGameId('')
  }
  function unlinkGame(deviceId: string): void {
    if (!game) {
      return
    }
    run(() =>
      saveGame({
        ...game,
        links: game.links.filter((item) => item.deviceId !== deviceId),
        excludedDevices: [...(game.excludedDevices ?? []), deviceId],
      }),
    )
  }
  function linkGame(): void {
    if (!game || !linkPeerId || !linkGameId) {
      return
    }
    run(async () => {
      await saveGame({
        ...game,
        links: [...game.links, { deviceId: linkPeerId, gameId: linkGameId }],
        excludedDevices: (game.excludedDevices ?? []).filter((id) => id !== linkPeerId),
      })
      setPeerId(linkPeerId)
      setLinkPeerId('')
      setLinkGameId('')
    })
  }
  function importGame(): void {
    const choice = importable.find((item) => item.key === importKey)
    if (!choice) {
      return
    }
    run(async () => {
      const item: LibraryGame = {
        id: crypto.randomUUID(),
        name: choice.item.name,
        rootId: null,
        links: [{ deviceId: choice.peer.device.id, gameId: choice.item.id }],
      }
      await adapter.saveGames([...(snapshotRef.current?.config.games ?? []), item])
      setGameId(item.id)
      setPeerId(choice.peer.device.id)
      setIsImportOpen(false)
      setPage('edit')
    })
  }
  function removeGame(): void {
    setIsGameMenuOpen(false)
    setConfirmation({
      title: '移除游戏',
      text: '移除游戏配置和设备关联，保留存档文件。',
      work: async () => {
        await adapter.saveGames(config.games.filter((item) => item.id !== gameId))
        setConfirmation(null)
        setPage('games')
      },
    })
  }
  function previewError(): string {
    if (!selectedPeer?.isConnected) {
      return '请连接这个游戏关联的设备。'
    }
    if (!source || !target) {
      return '请读取两端目录。'
    }
    if (!source.files.length) {
      return '请选择当前层要传输的文件。'
    }
    const names = source.files.map((file) => targetNames[file.entryId] ?? file.name)
    if (!names.every(isPortableFileName)) {
      return '请填写有效的单个目标文件名。'
    }
    if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) {
      return '本批次有重复的目标文件名。'
    }
    if (
      target.listing.entries.some((entry) =>
        names.some((name) => name.toLowerCase() === entry.name.toLowerCase()),
      )
    ) {
      return '目标有同名条目，请修改目标名称。'
    }
    if (isMobile && !upload && !snapshot?.grantedRoots.includes(target.rootId)) {
      return '请先允许手机目录接收文件。'
    }
    return ''
  }
  function start(): void {
    if (!game || !source || !target || !selectedPeer) {
      return
    }
    const problem = previewError()
    if (problem) {
      setError(problem)
      return
    }
    setConfirmation({
      title: upload ? '手机 → 电脑' : '电脑 → 手机',
      text: `${game.name} · ${selectedPeer.device.name}，新建 ${source.files.length} 个文件。`,
      work: async () => {
        await adapter.start({
          deviceId: peerId,
          upload,
          sourceRootId: source.rootId,
          targetRootId: target.rootId,
          targetParentId: target.parentId,
          files: source.files,
          names: targetNames,
          title: `${game.name} · ${selectedPeer.device.name}`,
        })
        setConfirmation(null)
        setPage('task')
      },
    })
  }
  backHandler.current = () => {
    if (confirmation) {
      if (!isBusy) {
        setConfirmation(null)
      }
      return true
    }
    if (isDeviceEditorOpen) {
      setIsDeviceEditorOpen(false)
      return true
    }
    if (isImportOpen) {
      setIsImportOpen(false)
      return true
    }
    if (isGameMenuOpen) {
      setIsGameMenuOpen(false)
      return true
    }
    if (page !== 'games') {
      setPage('games')
      return true
    }
    return false
  }
  let body: React.ReactNode
  if (page === 'devices') {
    body = (
      <DevicesPage
        snapshot={snapshot}
        peers={peers}
        online={online}
        copied={copied}
        port={port}
        isMobile={isMobile}
        isBusy={isBusy}
        isDisabled={isDisabled}
        isActive={isActive}
        onPortChange={setPort}
        onToggleService={toggleService}
        onCopyAddress={copyAddress}
        onAddDevice={() => deviceEditor(null)}
        onDeviceAction={actOnDevice}
        onManageDevice={deviceEditor}
      />
    )
  } else if (page === 'games') {
    body = (
      <GamesPage
        games={config.games}
        online={online}
        hasTasks={Boolean(snapshot?.tasks.length)}
        hasImportableGames={Boolean(importable.length)}
        isDisabled={isDisabled}
        isActive={isActive}
        onOpenGame={openGame}
        onOpenImport={() => {
          setImportKey('')
          setIsImportOpen(true)
        }}
        onAddGame={addGame}
        onOpenTasks={() => setPage('task')}
      />
    )
  } else if (page === 'edit' && game) {
    body = (
      <GameSettingsPage
        game={game}
        peers={peers}
        localRoot={localRoot}
        grantedRootIds={snapshot?.grantedRoots ?? []}
        linkPeerId={linkPeerId}
        linkGameId={linkGameId}
        isMobile={isMobile}
        isDisabled={isDisabled}
        isActive={isActive}
        onRename={renameGame}
        onChooseDirectory={chooseDirectory}
        onUnlink={unlinkGame}
        onLinkPeerChange={changeLinkPeer}
        onLinkGameChange={setLinkGameId}
        onLink={linkGame}
        onManageDevices={() => setPage('devices')}
      />
    )
  } else if ((page === 'transfer' || page === 'preview') && game) {
    body = (
      <TransferPage
        adapter={adapter}
        page={page}
        game={game}
        peers={peers}
        selectedPeer={selectedPeer}
        remoteGame={remoteGame}
        localRoot={localRoot}
        peerId={peerId}
        upload={upload}
        targetNames={targetNames}
        source={source}
        isMobile={isMobile}
        isDisabled={isDisabled}
        isActive={isActive}
        previewMessage={previewError()}
        onPeerChange={changePeer}
        onUploadChange={changeUpload}
        onLocalLocation={setLocalLocation}
        onRemoteLocation={setRemoteLocation}
        onChooseReceive={() => chooseDirectory(true)}
        onOpenSettings={() => setPage('edit')}
        onTargetNameChange={(entryId, value) =>
          setTargetNames((values) => ({ ...values, [entryId]: value }))
        }
      />
    )
  } else if (page === 'task') {
    body = (
      <TaskPage
        tasks={snapshot?.tasks ?? []}
        isBusy={isBusy}
        onCancel={(id) => run(() => adapter.cancel(id))}
        onCleanup={() => run(() => adapter.cleanup())}
      />
    )
  } else if (page === 'backup') {
    body = <BackupPage />
  } else if (page === 'settings') {
    body = (
      <SettingsPage
        snapshot={snapshot}
        isMobile={isMobile}
        isDisabled={isDisabled}
        isActive={isActive}
        onRevokeReceive={(rootId) => run(() => adapter.revokeReceive(rootId))}
      />
    )
  } else {
    body = <Empty description="请选择游戏" />
  }
  const footer =
    (page === 'transfer' || page === 'preview') && game ? (
      <footer className="library-transfer-action">
        <Button
          type="primary"
          block
          disabled={
            isDisabled ||
            isActive ||
            !isMobile ||
            !source?.files.length ||
            !target ||
            !selectedPeer?.isConnected ||
            (page === 'preview' && Boolean(previewError()))
          }
          onClick={() => (page === 'preview' ? start() : setPage('preview'))}
        >
          {page === 'preview' ? '开始传输' : '预览本次变化'}
        </Button>
      </footer>
    ) : null
  const dialogs = (
    <>
      <GameMenu
        isMobile={isMobile}
        isOpen={isGameMenuOpen}
        gameName={game?.name ?? null}
        onClose={() => setIsGameMenuOpen(false)}
      >
        <GameActions
          isActive={isActive}
          onTransfer={() => go('transfer')}
          onSettings={() => go('edit')}
          onBackup={() => go('backup')}
          onTasks={() => go('task')}
          onRemove={removeGame}
        />
      </GameMenu>
      <DeviceEditorDialog
        isOpen={isDeviceEditorOpen}
        editingDeviceId={editingDeviceId}
        deviceName={deviceName}
        deviceAddress={deviceAddress}
        isMobile={isMobile}
        isBusy={isBusy}
        isActive={isActive}
        onDeviceNameChange={setDeviceName}
        onDeviceAddressChange={setDeviceAddress}
        onCancel={() => setIsDeviceEditorOpen(false)}
        onSave={saveDevice}
        onRemove={removeDevice}
      />
      <ImportGameDialog
        isOpen={isImportOpen}
        importKey={importKey}
        isBusy={isBusy}
        options={importable.map((item) => ({
          value: item.key,
          label: `${item.peer.device.name} / ${item.item.name}`,
        }))}
        onImportKeyChange={setImportKey}
        onCancel={() => setIsImportOpen(false)}
        onImport={importGame}
      />
      <ConfirmationDialog
        confirmation={confirmation}
        isBusy={isBusy}
        onCancel={() => {
          if (!isBusy) {
            setConfirmation(null)
          }
        }}
        onConfirm={() => {
          if (confirmation) {
            run(confirmation.work)
          }
        }}
      />
    </>
  )
  return (
    <LibraryShell
      isMobile={isMobile}
      isDark={isDark}
      page={page}
      title={PAGE_TITLES[page]}
      gameName={game?.name ?? null}
      error={error}
      isBusy={isBusy}
      footer={footer}
      dialogs={dialogs}
      onBack={() => setPage('games')}
      onNavigate={go}
      onCloseError={() => setError('')}
      onRetry={() => run(async () => {})}
    >
      {body}
    </LibraryShell>
  )
}
