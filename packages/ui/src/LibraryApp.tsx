import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  ConfigProvider,
  Empty,
  Flex,
  Input,
  InputNumber,
  Menu,
  Modal,
  Segmented,
  Select,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd'
import type { ModalProps } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { ConfigProvider as MobileConfigProvider, NavBar, Popup, TabBar } from 'antd-mobile'
import mobileZhCN from 'antd-mobile/es/locales/zh-CN'
import {
  AndroidOutlined,
  ArrowLeftOutlined,
  CheckOutlined,
  CopyOutlined,
  DesktopOutlined,
  DownloadOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  PlusOutlined,
  SettingOutlined,
  SwapOutlined,
  AppstoreOutlined,
} from '@ant-design/icons'
import { emptyLibrary, isPortableFileName } from '@savedata-sync/shared'
import type { LibraryGame } from '@savedata-sync/shared'
import { taskIsActive } from './api.ts'
import type { UiAdapter, UiSnapshot } from './api.ts'
import { DirectoryPane } from './DirectoryPane.tsx'
import type { PaneLocation } from './DirectoryPane.tsx'
import { TaskView } from './TaskView.tsx'
import './style.css'

type Page = 'devices' | 'games' | 'settings' | 'edit' | 'transfer' | 'preview' | 'task' | 'backup'
interface Confirmation {
  readonly title: string
  readonly text: string
  readonly work: () => Promise<void>
  readonly okType?: ModalProps['okType']
}
const EMPTY = emptyLibrary()
const NAV = [
  { key: 'devices', label: '设备', icon: <DesktopOutlined /> },
  { key: 'games', label: '游戏', icon: <AppstoreOutlined /> },
  { key: 'settings', label: '设置', icon: <SettingOutlined /> },
]

/** 双端共用组件与状态；平台能力由 adapter 注入，初始化及保存失败都保留错误供重试。 */
export function LibraryApp({ adapter }: { readonly adapter: UiAdapter }): React.JSX.Element {
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
  const online = peers.find((item) => item.isConnected)
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
  const activeNav = ['devices', 'settings'].includes(page) ? page : 'games'
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
  function addressField(address: string): React.JSX.Element {
    return (
      <Space.Compact block className="library-compact">
        <Input readOnly aria-label="HTTP 地址" value={address} />
        <Button
          icon={copied === address ? <CheckOutlined /> : <CopyOutlined />}
          aria-label="复制地址"
          onClick={() =>
            run(async () => {
              await navigator.clipboard.writeText(address)
              setCopied(address)
            })
          }
        />
      </Space.Compact>
    )
  }
  function go(value: Page): void {
    setIsGameMenuOpen(false)
    setPage(value)
  }
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
  let body: React.ReactNode
  if (page === 'devices') {
    body = (
      <>
        {snapshot?.service && (
          <Card
            title="本机服务"
            extra={
              <Button
                disabled={isDisabled}
                onClick={() => {
                  if (snapshot.service?.isRunning && isActive) {
                    setConfirmation({
                      title: '停止服务',
                      text: '将断开设备，并取消当前传输。',
                      work: async () => {
                        await adapter.service(false, port ?? 0)
                        setConfirmation(null)
                      },
                    })
                  } else {
                    run(() => adapter.service(!snapshot.service?.isRunning, port ?? 0))
                  }
                }}
              >
                {snapshot.service.isRunning ? '停止' : '启动'}
              </Button>
            }
          >
            {snapshot.service.addresses.map((address) => (
              <div className="library-address" key={address}>
                {addressField(address)}
              </div>
            ))}
            <Flex align="center" style={{ margin: '16px 4px 0px' }} gap="small">
              端口设置
              <InputNumber
                aria-label="监听端口"
                min={0}
                max={65535}
                precision={0}
                value={port}
                disabled={snapshot.service.isRunning || isBusy}
                onChange={setPort}
              />
              <Typography.Text type="secondary"> 0 为自动分配</Typography.Text>
            </Flex>
          </Card>
        )}
        <div className="library-section-heading">
          <h2>已保存的设备</h2>
          {isMobile && (
            <Button
              icon={<PlusOutlined />}
              disabled={isDisabled || isActive}
              onClick={() => deviceEditor(null)}
            >
              添加电脑
            </Button>
          )}
        </div>
        {peers.length ? (
          <div className="library-device-grid">
            {peers.map((peer) => (
              <Card key={peer.device.id} className="library-device-card">
                <Flex align="flex-start" gap="small">
                  <div className="library-device-icon">
                    {isMobile ? <DesktopOutlined /> : <AndroidOutlined />}
                  </div>
                  <Flex vertical={true}>
                    <div style={{ fontWeight: 'bold' }}>{peer.device.name}</div>
                    {peer.device.address && addressField(peer.device.address)}
                    <Tag color={peer.isConnected ? 'success' : 'default'}>
                      {peer.isConnected ? '已连接' : peer.device.blocked ? '已断开' : '未连接'}
                    </Tag>
                  </Flex>
                </Flex>
                <Space wrap>
                  <Button
                    disabled={
                      isDisabled || isActive || (!peer.isConnected && isMobile && Boolean(online))
                    }
                    onClick={() =>
                      run(() =>
                        adapter.device(peer.device.id, peer.isConnected ? 'disconnect' : 'allow'),
                      )
                    }
                  >
                    {peer.isConnected
                      ? '断开'
                      : isMobile
                        ? '连接'
                        : peer.device.blocked
                          ? '允许连接'
                          : '等待手机连接'}
                  </Button>
                  <Button disabled={isDisabled} onClick={() => deviceEditor(peer.device.id)}>
                    管理
                  </Button>
                </Space>
              </Card>
            ))}
          </div>
        ) : (
          <Empty description={isMobile ? '添加电脑地址后连接' : '手机连接后会显示在这里'} />
        )}
      </>
    )
  } else if (page === 'games') {
    body = (
      <>
        <div className="library-section-heading">
          <Typography.Text type="secondary">
            {online ? `${online.device.name} · 已连接` : '未连接设备'}
          </Typography.Text>
          <Space>
            <Button
              icon={<DownloadOutlined />}
              disabled={isDisabled || !importable.length}
              onClick={() => {
                setImportKey('')
                setIsImportOpen(true)
              }}
            >
              导入游戏
            </Button>
            <Button type="primary" icon={<PlusOutlined />} disabled={isDisabled} onClick={addGame}>
              添加游戏
            </Button>
          </Space>
        </div>
        {snapshot?.tasks.length ? (
          <Button
            block
            icon={<SwapOutlined />}
            className="library-task-shortcut"
            onClick={() => setPage('task')}
          >
            {isActive ? '传输进行中' : '查看传输结果'}
          </Button>
        ) : null}
        {config.games.length ? (
          <div className="library-game-grid">
            {config.games.map((item, index) => (
              <Card key={item.id} hoverable className="library-game-card">
                <Button
                  type="text"
                  block
                  className={`library-game-cover cover-${index % 3}`}
                  onClick={() => openGame(item)}
                >
                  <FolderOutlined />
                  <strong>{item.name}</strong>
                </Button>
                <h3>{item.name}</h3>
                <Typography.Text type="secondary">
                  已关联 {item.links.length} 台设备
                </Typography.Text>
              </Card>
            ))}
          </div>
        ) : (
          <Empty description="添加游戏并选择本机存档目录" />
        )}
      </>
    )
  } else if (page === 'edit' && game) {
    body = (
      <>
        <Card>
          <label className="library-field">
            游戏名称
            <Input
              key={game.id}
              defaultValue={game.name}
              maxLength={128}
              onBlur={(event) => {
                const value = event.target.value.trim()
                if (!value) {
                  setError('游戏名称不能为空。')
                  return
                }
                if (value !== game.name) {
                  run(() => saveGame({ ...game, name: value }))
                }
              }}
            />
          </label>
        </Card>
        <Card title={`本机${isMobile ? '手机' : '电脑'}目录`}>
          <Space.Compact block className="library-compact">
            <Input
              readOnly
              aria-label="本机存档目录"
              value={localRoot?.displayName ?? ''}
              placeholder="未选择目录"
              prefix={<FolderOutlined />}
            />
            <Button
              icon={<FolderOpenOutlined />}
              aria-label="选择目录"
              disabled={isDisabled || isActive}
              onClick={() => chooseDirectory(false)}
            />
          </Space.Compact>
          <Button
            className="library-receive-button"
            disabled={isDisabled || isActive}
            onClick={() => chooseDirectory(true)}
          >
            {game.rootId && snapshot?.grantedRoots.includes(game.rootId)
              ? '重新选择并授权接收'
              : '允许接收新文件'}
          </Button>
        </Card>
        <Card title="已关联设备">
          {game.links.map((link) => {
            const peer = peers.find((item) => item.device.id === link.deviceId)
            const remote = peer?.games.find((item) => item.id === link.gameId)
            return (
              <div className="library-linked-row" key={link.deviceId}>
                <div>
                  <strong>{peer?.device.name ?? '设备已移除'}</strong>
                  <p>
                    {remote?.root?.displayName ??
                      (peer?.isConnected ? '此设备尚未设置目录' : '连接后读取目录')}
                  </p>
                </div>
                <Button
                  disabled={isDisabled || isActive}
                  onClick={() =>
                    run(() =>
                      saveGame({
                        ...game,
                        links: game.links.filter((item) => item.deviceId !== link.deviceId),
                        excludedDevices: [...(game.excludedDevices ?? []), link.deviceId],
                      }),
                    )
                  }
                >
                  解除关联
                </Button>
              </div>
            )
          })}
          {!game.links.length && (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未关联设备" />
          )}
          <Space orientation="vertical" className="library-full">
            <Select
              aria-label="关联设备"
              className="library-full"
              placeholder="选择设备"
              value={linkPeerId || null}
              options={peers
                .filter((peer) => !game.links.some((link) => link.deviceId === peer.device.id))
                .map((peer) => ({
                  value: peer.device.id,
                  label: peer.device.name,
                  disabled: !peer.isConnected,
                }))}
              onChange={(id: string) => {
                setLinkPeerId(id)
                setLinkGameId('')
              }}
            />
            <Select
              aria-label="对应游戏"
              className="library-full"
              placeholder="选择这台设备上的游戏"
              value={linkGameId || null}
              options={
                peers
                  .find((item) => item.device.id === linkPeerId)
                  ?.games.map((item) => ({ value: item.id, label: item.name })) ?? []
              }
              onChange={setLinkGameId}
            />
            <Button
              disabled={isDisabled || !linkPeerId || !linkGameId || isActive}
              onClick={() =>
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
            >
              关联
            </Button>
          </Space>
        </Card>
        <Button onClick={() => setPage('devices')}>管理设备</Button>
      </>
    )
  } else if ((page === 'transfer' || page === 'preview') && game) {
    body = (
      <>
        <label className="library-field">
          对端设备
          <Select
            aria-label="对端设备"
            value={selectedPeer ? peerId : null}
            className="library-full"
            placeholder="选择本次对端"
            disabled={isBusy || isActive}
            options={game.links.map((link) => {
              const peer = peers.find((item) => item.device.id === link.deviceId)
              return {
                value: link.deviceId,
                label: `${peer?.device.name ?? '未知设备'} · ${peer?.isConnected ? '已连接' : '未连接'}`,
              }
            })}
            onChange={(id: string) => {
              setPeerId(id)
              setLocalLocation(null)
              setRemoteLocation(null)
              setTargetNames({})
              setPage('transfer')
            }}
          />
        </label>
        <div className="library-dual">
          <DirectoryPane
            key={`local-${game.id}-${game.rootId ?? ''}-${String(upload)}`}
            adapter={adapter}
            deviceId={null}
            root={localRoot}
            title={`本机${isMobile ? '手机' : '电脑'}`}
            isSource={isLocalSource}
            isDisabled={isDisabled || isActive}
            isOnline
            onLocation={setLocalLocation}
          />
          <DirectoryPane
            key={`remote-${game.id}-${peerId}-${remoteGame?.root?.rootId ?? ''}-${String(upload)}`}
            adapter={adapter}
            deviceId={peerId || null}
            root={remoteGame?.root ?? null}
            title={selectedPeer?.device.name ?? '对端设备'}
            isSource={!isLocalSource}
            isDisabled={isDisabled || isActive}
            isOnline={Boolean(selectedPeer?.isConnected)}
            onLocation={setRemoteLocation}
          />
        </div>
        <Segmented
          block
          disabled={isDisabled || isActive}
          value={upload ? 'upload' : 'download'}
          options={[
            { label: '电脑 → 手机', value: 'download' },
            { label: '手机 → 电脑', value: 'upload' },
          ]}
          onChange={(value) => {
            setUpload(value === 'upload')
            setTargetNames({})
            setPage('transfer')
          }}
        />
        <Card size="small" className="library-rules">
          <div>
            <span>删除目标端多出的文件</span>
            <Tooltip title="镜像删除将在后续版本开放">
              <Switch checked={false} disabled size="small" aria-label="删除目标端多出的文件" />
            </Tooltip>
          </div>
          <div>
            <span>覆盖前备份</span>
            <Tooltip title="覆盖复制与备份将在后续版本开放">
              <Switch checked disabled size="small" aria-label="覆盖前备份" />
            </Tooltip>
          </div>
        </Card>
        <Alert type="info" showIcon title="当前新建文件，同名文件请在预览中改名。" />
        {!isMobile && (
          <Alert type="info" title="在手机发起传输，电脑显示任务与接收结果。" showIcon />
        )}
        <Space wrap>
          <Button disabled={isDisabled || isActive} onClick={() => setPage('edit')}>
            目录设置
          </Button>
          {isMobile && (
            <Button disabled={isDisabled || isActive} onClick={() => chooseDirectory(true)}>
              允许手机接收
            </Button>
          )}
        </Space>
        {page === 'preview' && (
          <Card title={`新建 ${source?.files.length ?? 0} 个文件`}>
            {source?.files.map((file) => (
              <label className="library-field" key={file.entryId}>
                {file.name}
                <Input
                  aria-label={`${file.name} 的目标名称`}
                  value={targetNames[file.entryId] ?? file.name}
                  onChange={(event) =>
                    setTargetNames((values) => ({ ...values, [file.entryId]: event.target.value }))
                  }
                />
              </label>
            ))}
            {previewError() && <Alert type="warning" title={previewError()} showIcon />}
          </Card>
        )}
      </>
    )
  } else if (page === 'task') {
    body = (
      <TaskView
        tasks={snapshot?.tasks ?? []}
        isBusy={isBusy}
        onCancel={(id) => run(() => adapter.cancel(id))}
        onCleanup={() => run(() => adapter.cleanup())}
      />
    )
  } else if (page === 'backup') {
    body = <Empty description="备份与恢复将在覆盖复制开放时提供" />
  } else if (page === 'settings') {
    body = (
      <>
        <Card title="外观">
          <p>主题：跟随系统</p>
        </Card>
        {!isMobile && Boolean(snapshot?.grantedRoots.length) && (
          <Card title="接收目录">
            {snapshot?.grantedRoots.map((id) => (
              <div className="library-linked-row" key={id}>
                <span>
                  {snapshot.roots.find((root) => root.rootId === id)?.displayName ?? '已授权目录'}
                </span>
                <Button
                  disabled={isDisabled || isActive}
                  onClick={() => run(() => adapter.revokeReceive(id))}
                >
                  撤销接收授权
                </Button>
              </div>
            ))}
          </Card>
        )}
        <Card title="存档同步">
          <p>版本 0.1.0</p>
        </Card>
      </>
    )
  } else {
    body = <Empty description="请选择游戏" />
  }
  const title = {
    devices: '设备',
    games: '游戏',
    settings: '设置',
    edit: '游戏目录',
    transfer: '传输存档',
    preview: '确认本次变化',
    task: '传输详情',
    backup: '备份与恢复',
  }[page]
  const gameActions = (
    <Space orientation="vertical" className="library-full">
      <Button block type="primary" icon={<SwapOutlined />} onClick={() => go('transfer')}>
        传输存档
      </Button>
      <Button block onClick={() => go('edit')}>
        目录设置
      </Button>
      <Button block onClick={() => go('backup')}>
        备份与恢复
      </Button>
      <Button block onClick={() => go('task')}>
        本次传输
      </Button>
      <Button
        block
        danger
        disabled={isActive}
        onClick={() => {
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
        }}
      >
        移除游戏
      </Button>
    </Space>
  )
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: {
          colorPrimary: '#286add',
          borderRadius: 12,
          colorBgLayout: isDark ? '#000000' : '#f0f5fc',
        },
        components: { Card: { bodyPadding: 20 } },
      }}
    >
      <MobileConfigProvider locale={mobileZhCN}>
        <div
          className={`library-app ${isMobile ? 'library-mobile' : 'library-desktop'} ${isDark ? 'library-dark' : ''}`}
        >
          {!isMobile && (
            <aside className="library-sidebar">
              <div className="library-brand">
                <SwapOutlined /> 存档同步
              </div>
              <Menu
                mode="inline"
                selectedKeys={[activeNav]}
                items={NAV}
                onClick={({ key }) => setPage(key as Page)}
              />
              <small>版本 0.1.0</small>
            </aside>
          )}
          <div className="library-surface">
            <header className="library-header">
              {isMobile ? (
                <NavBar
                  back={['games', 'devices', 'settings'].includes(page) ? null : '游戏'}
                  onBack={() => setPage('games')}
                >
                  {title}
                </NavBar>
              ) : (
                <>
                  <div>
                    {!['games', 'devices', 'settings'].includes(page) && (
                      <Button icon={<ArrowLeftOutlined />} onClick={() => setPage('games')}>
                        游戏
                      </Button>
                    )}
                    <h1>{title}</h1>
                    {game && !['games', 'devices', 'settings', 'task'].includes(page) && (
                      <p>{game.name}</p>
                    )}
                  </div>
                </>
              )}
            </header>
            <main className="library-main">
              {error && (
                <Alert
                  type="error"
                  title={error}
                  showIcon
                  closable={{ onClose: () => setError('') }}
                  action={
                    <Button size="small" disabled={isBusy} onClick={() => run(async () => {})}>
                      重试
                    </Button>
                  }
                />
              )}
              <div className="library-stack">{body}</div>
            </main>
            {(page === 'transfer' || page === 'preview') && game && (
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
            )}
          </div>
          {isMobile && (
            <div className="library-bottom">
              <TabBar activeKey={activeNav} onChange={(value) => setPage(value as Page)}>
                {NAV.map((item) => (
                  <TabBar.Item key={item.key} icon={item.icon} title={item.label} />
                ))}
              </TabBar>
            </div>
          )}
        </div>
        {isMobile ? (
          <Popup
            visible={isGameMenuOpen}
            onMaskClick={() => setIsGameMenuOpen(false)}
            onClose={() => setIsGameMenuOpen(false)}
            bodyClassName="library-game-popup"
          >
            <h2>{game?.name}</h2>
            {gameActions}
          </Popup>
        ) : (
          <Modal
            title={game?.name}
            open={isGameMenuOpen}
            footer={null}
            onCancel={() => setIsGameMenuOpen(false)}
          >
            {gameActions}
          </Modal>
        )}
        <Modal
          title={editingDeviceId ? '管理设备' : '添加电脑'}
          open={isDeviceEditorOpen}
          confirmLoading={isBusy}
          okText={editingDeviceId ? '保存' : '连接'}
          onCancel={() => setIsDeviceEditorOpen(false)}
          onOk={() =>
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
          footer={(_, { OkBtn, CancelBtn }) => (
            <>
              {editingDeviceId && (
                <Button
                  danger
                  disabled={isBusy || isActive}
                  onClick={() =>
                    setConfirmation({
                      title: '移除设备',
                      text: '移除设备和相关游戏关联，保留存档文件。',
                      okType: 'danger',
                      work: async () => {
                        await adapter.device(editingDeviceId, 'forget')
                        setIsDeviceEditorOpen(false)
                        setConfirmation(null)
                      },
                    })
                  }
                >
                  移除设备
                </Button>
              )}
              <OkBtn />
              <CancelBtn />
            </>
          )}
        >
          <Space orientation="vertical" className="library-full">
            {editingDeviceId && (
              <label className="library-field">
                设备名称
                <Input
                  value={deviceName}
                  maxLength={128}
                  onChange={(event) => setDeviceName(event.target.value)}
                />
              </label>
            )}
            {isMobile && (
              <label className="library-field">
                电脑 HTTP 地址
                <Input
                  placeholder="http://192.168.1.100:端口"
                  value={deviceAddress}
                  onChange={(event) => setDeviceAddress(event.target.value)}
                />
              </label>
            )}
          </Space>
        </Modal>
        <Modal
          title="从设备导入游戏"
          open={isImportOpen}
          okText="导入"
          okButtonProps={{ disabled: !importKey }}
          confirmLoading={isBusy}
          onCancel={() => setIsImportOpen(false)}
          onOk={importGame}
        >
          <Select
            className="library-full"
            aria-label="导入游戏"
            value={importKey || null}
            placeholder="选择游戏"
            options={importable.map((item) => ({
              value: item.key,
              label: `${item.peer.device.name} / ${item.item.name}`,
            }))}
            onChange={setImportKey}
          />
        </Modal>
        <Modal
          title={confirmation?.title}
          open={Boolean(confirmation)}
          confirmLoading={isBusy}
          okText="确认"
          okType={confirmation?.okType ?? 'primary'}
          cancelText="取消"
          onCancel={() => {
            if (!isBusy) {
              setConfirmation(null)
            }
          }}
          onOk={() => {
            if (confirmation) {
              run(confirmation.work)
            }
          }}
        >
          <p>{confirmation?.text}</p>
        </Modal>
      </MobileConfigProvider>
    </ConfigProvider>
  )
}
