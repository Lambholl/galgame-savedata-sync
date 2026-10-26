import { useEffect, useRef, useState } from 'react'
import { APP_NAME, isPortableFileName, PROTOCOL_VERSION } from '@savedata-sync/shared'
import type { BatchDeviceDescriptor, OperationResult } from '@savedata-sync/shared'
import { Button, Card, ConfigProvider, Dialog, Input, NavBar, Selector } from 'antd-mobile'
import zhCN from 'antd-mobile/es/locales/zh-CN'
import { androidDirectories } from './saf-directories'
import { androidTransfers } from './http-transfers'
import type { AndroidDirectoryApi } from './saf-directory-bridge'
import type { CurrentTransfer, TransferStartOptions } from './http-transfer-bridge'
import { DirectoryPanel } from './DirectoryPanel'
import type { DirectoryLocation } from './DirectoryPanel'
import { TaskPanel } from './TaskPanel'
import { useTransferTask } from './use-transfer-task'

const LOCAL_TARGET: AndroidDirectoryApi = {
  ...androidDirectories,
  chooseDirectory: () => androidTransfers.chooseTarget(),
}
const REMOTE_DIRECTORIES: AndroidDirectoryApi = {
  listRoots: () => androidTransfers.listRemoteRoots(),
  listDirectory: (rootId, parentId) => androidTransfers.listRemoteDirectory(rootId, parentId),
  chooseDirectory: () => Promise.resolve({ status: 'cancelled' }),
}
const ADDRESS_KEY = 'savedata-sync:m001-address'

function readAddress(): string {
  try {
    return localStorage.getItem(ADDRESS_KEY) ?? ''
  } catch {
    return ''
  }
}

/** 手机主动连接并发起双向验证；目录配置由原生保存，网页只保存手动地址。 */
export function App(): React.JSX.Element {
  const [address, setAddress] = useState(readAddress)
  const [device, setDevice] = useState<BatchDeviceDescriptor | null>(null)
  const [upload, setUpload] = useState(false)
  const [localDirectory, setLocalDirectory] = useState<DirectoryLocation | null>(null)
  const [remoteDirectory, setRemoteDirectory] = useState<DirectoryLocation | null>(null)
  const [grantedRoots, setGrantedRoots] = useState<readonly string[]>([])
  const [targetNames, setTargetNames] = useState<Readonly<Record<string, string>>>({})
  const [task, setTask] = useState<CurrentTransfer | null>(null)
  const [taskLocations, setTaskLocations] = useState<{
    readonly source: string
    readonly target: string
  } | null>(null)
  const [error, setError] = useState('')
  const [isBusy, setIsBusy] = useState(false)
  const [isRestoring, setIsRestoring] = useState(true)
  const operationLock = useRef(false)
  const taskState = useTransferTask(task)
  const isActive = Boolean(
    task &&
    (!taskState.local ||
      taskState.local.status === 'running' ||
      taskState.remote?.status === 'running' ||
      (task.upload && taskState.local.status === 'sent' && !taskState.remote)),
  )
  const isLocked = isBusy || isRestoring || isActive
  const source = upload ? localDirectory : remoteDirectory
  const target = upload ? remoteDirectory : localDirectory
  useEffect(() => {
    let isCurrent = true
    androidTransfers
      .current()
      .then((result) => {
        if (!isCurrent) return
        if (result.status === 'success' && result.value) {
          setTask(result.value)
          setDevice(result.value.device)
          setUpload(result.value.upload)
        } else if (result.status === 'error') setError(result.error.message)
      })
      .catch(() => {
        if (isCurrent) setError('读取原生任务失败，请重开应用核实。')
      })
      .finally(() => {
        if (isCurrent) setIsRestoring(false)
      })
    return () => {
      isCurrent = false
    }
  }, [])
  function run(work: () => Promise<void>): void {
    if (operationLock.current) return
    operationLock.current = true
    setIsBusy(true)
    setError('')
    work()
      .catch(() => setError('操作失败，请核实当前目录和任务结果。'))
      .finally(() => {
        operationLock.current = false
        setIsBusy(false)
      })
  }
  function check<T>(result: OperationResult<T>): T {
    if (result.status === 'error')
      throw new Error(`${result.error.message}（${result.error.code}）`)
    return result.value
  }
  function runWithError(work: () => Promise<void>): void {
    run(async () => {
      try {
        await work()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '操作失败，请核实当前状态。')
      }
    })
  }
  function changeDirection(next: boolean): void {
    setUpload(next)
    setLocalDirectory(null)
    setRemoteDirectory(null)
    setTargetNames({})
  }
  function start(): void {
    runWithError(async () => {
      if (!device || !source || !target || source.files.length === 0)
        throw new Error('请选择源文件和目标目录。')
      if (!upload && !grantedRoots.includes(target.rootId))
        throw new Error('请在手机目录中点“选择并允许接收”，授权本次测试目标。')
      if (source.files.length > device.limits.maxFiles)
        throw new Error(`每批最多 ${device.limits.maxFiles} 个文件。`)
      const names = source.files.map((file) => targetNames[file.entryId] ?? file.name)
      if (!names.every(isPortableFileName))
        throw new Error('目标名称须为单个有效文件名，请检查空名、路径分隔符和保留名称。')
      const keys = names.map((name) => name.toLowerCase())
      if (new Set(keys).size !== keys.length) throw new Error('本批目标文件名重复，请修改名称。')
      if (target.listing.entries.some((entry) => keys.includes(entry.name.toLowerCase())))
        throw new Error('目标已有同名条目，请修改目标文件名或选择其他目录。')
      if (
        !(await Dialog.confirm({
          title: upload ? '手机 → 电脑' : '电脑 → 手机',
          content: (
            <div>
              <p>源：{source.label}</p>
              <p>目标：{target.label}</p>
              <p>新建 {names.length} 个文件，同名冲突时停止。</p>
            </div>
          ),
          confirmText: '开始传输',
        }))
      )
        return
      const canNotify = check(await androidTransfers.requestNotifications())
      if (!canNotify)
        throw new Error('请在 Android 设置中允许本应用及传输通道显示通知，再开始传输。')
      const options: TransferStartOptions = {
        request: {
          protocolVersion: PROTOCOL_VERSION,
          transferId: crypto.randomUUID(),
          sourceRootId: source.rootId,
          files: source.files.map((file, index) => ({
            fileId: `f${String(index + 1).padStart(6, '0')}`,
            entryId: file.entryId,
          })),
        },
        targetRootId: target.rootId,
        targets: source.files.map((file, index) => ({
          fileId: `f${String(index + 1).padStart(6, '0')}`,
          parentId: target.parentId,
          name: targetNames[file.entryId] ?? file.name,
        })),
      }
      check(
        await (upload
          ? androidTransfers.startUpload(options)
          : androidTransfers.startDownload(options)),
      )
      setTask({ options, upload, device })
      setTaskLocations({ source: source.label, target: target.label })
    })
  }
  return (
    <ConfigProvider locale={zhCN}>
      <NavBar backIcon={false}>{APP_NAME}</NavBar>
      <main className="app-content">
        <header>
          <h1>目录与文件往返验证</h1>
          <p className="muted">M-001 · 使用独立测试目录，新建文件</p>
        </header>
        {error && (
          <div role="alert" className="error-message">
            {error}
            <Button size="mini" fill="none" onClick={() => setError('')}>
              关闭提示
            </Button>
          </div>
        )}
        <Card
          title="连接电脑"
          extra={<span className="role-label">{device ? '已连接' : '未连接'}</span>}
        >
          <label htmlFor="computer-address" className="field-label">
            电脑 HTTP 地址
          </label>
          <Input
            id="computer-address"
            value={address}
            onChange={setAddress}
            disabled={isLocked}
            placeholder="http://192.168.1.10:端口"
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
          />
          <p className="muted">两端连接同一局域网，地址见电脑的“局域网连接”。</p>
          <div className="button-row">
            <Button
              size="small"
              color="primary"
              disabled={isLocked || !address.trim()}
              onClick={() =>
                runWithError(async () => {
                  // connect 会清空旧原生连接；先撤下旧目录，失败时也不能继续使用旧引用。
                  setDevice(null)
                  setTask(null)
                  setTaskLocations(null)
                  setRemoteDirectory(null)
                  const value = check(await androidTransfers.connect(address.trim()))
                  setDevice(value)
                  try {
                    localStorage.setItem(ADDRESS_KEY, address.trim())
                  } catch {
                    setError('连接成功，地址保存失败；下次打开需重新输入。')
                  }
                })
              }
            >
              {device ? '重新连接' : '连接'}
            </Button>
            <Button
              size="small"
              disabled={isBusy || isRestoring || !device}
              onClick={() =>
                runWithError(async () => {
                  check(await androidTransfers.disconnect())
                  setDevice(null)
                  setTask(null)
                  setTaskLocations(null)
                  setRemoteDirectory(null)
                })
              }
            >
              断开连接
            </Button>
          </div>
          {device && (
            <p className="muted">
              {device.device.displayName} · 协议 {device.device.protocolVersion}
              <br />
              <span className="task-id">设备 ID：{device.device.deviceId}</span>
            </p>
          )}
        </Card>
        <Card title="传输方向">
          <Selector<string>
            columns={2}
            value={[upload ? 'upload' : 'download']}
            disabled={isLocked}
            options={[
              { label: '电脑 → 手机', value: 'download' },
              { label: '手机 → 电脑', value: 'upload' },
            ]}
            onChange={(values) => {
              const next = values[0]
              if (next) changeDirection(next === 'upload')
            }}
          />
          <p className="muted">
            在源目录选文件，进入目标目录后点击开始。文件夹用于浏览，文件按当前层选择。
          </p>
        </Card>
        <DirectoryPanel
          key={`local-${String(upload)}`}
          title="手机目录"
          api={upload ? androidDirectories : LOCAL_TARGET}
          isSource={upload}
          isWriteTarget={!upload}
          canChoose
          isDisabled={isLocked}
          onChange={setLocalDirectory}
          onGrant={(id) => setGrantedRoots((roots) => [...new Set([...roots, id])])}
        />
        {device && (
          <DirectoryPanel
            key={`remote-${device.sessionId}-${String(upload)}`}
            title="电脑目录"
            api={REMOTE_DIRECTORIES}
            isSource={!upload}
            canChoose={false}
            isDisabled={isLocked}
            onChange={setRemoteDirectory}
          />
        )}
        <Card title="确认源与目标">
          <p>源：{source?.label ?? '请选择源目录'}</p>
          <p>目标：{target?.label ?? '请选择目标目录'}</p>
          {source?.files.map((file) => (
            <label className="target-name" key={file.entryId}>
              <span>{file.name} →</span>
              <Input
                aria-label={`${file.name} 的目标名称`}
                value={targetNames[file.entryId] ?? file.name}
                disabled={isLocked}
                onChange={(value) =>
                  setTargetNames((names) => ({ ...names, [file.entryId]: value }))
                }
              />
            </label>
          ))}
          {!upload && target && !grantedRoots.includes(target.rootId) && (
            <p className="notice">请在手机目录中点“选择并允许接收”，确认独立测试目标。</p>
          )}
          {upload && <p className="muted">电脑目标须先在桌面点“选择并允许接收”。</p>}
          <Button
            block
            color="primary"
            loading={isBusy}
            disabled={
              isLocked ||
              !device ||
              !source?.files.length ||
              !target ||
              (!upload && !grantedRoots.includes(target.rootId))
            }
            onClick={start}
          >
            开始{upload ? '上传到电脑' : '下载到手机'}
            {source?.files.length ? ` · ${source.files.length} 个文件` : ''}
          </Button>
        </Card>
        {task && (
          <TaskPanel
            task={task}
            sourceLabel={taskLocations?.source ?? (task.upload ? '手机所选文件' : '电脑所选文件')}
            targetLabel={taskLocations?.target ?? (task.upload ? '电脑所选目录' : '手机所选目录')}
            {...taskState}
            isBusy={isBusy}
            onRefresh={taskState.refresh}
            onCancel={() =>
              runWithError(async () => {
                check(await androidTransfers.cancel(task.options.request.transferId))
                taskState.refresh()
              })
            }
            onCleanup={() =>
              runWithError(async () => {
                const cleaned = check(await androidTransfers.retryCleanup())
                if (!cleaned) throw new Error('仍有临时文件未清理，请核实权限与存储。')
                taskState.refresh()
              })
            }
          />
        )}
      </main>
    </ConfigProvider>
  )
}
