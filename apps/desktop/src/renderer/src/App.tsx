import { useEffect, useState } from 'react'
import { APP_NAME } from '@savedata-sync/shared'
import {
  Alert,
  Button,
  Card,
  ConfigProvider,
  InputNumber,
  Layout,
  Space,
  Tag,
  Typography,
  theme,
} from 'antd'
import zhCN from 'antd/locale/zh_CN'
import type { DesktopServiceSnapshot } from '../../service-bridge'
import type { OperationResult } from '@savedata-sync/shared'
import { useSystemDarkMode } from './use-system-dark-mode'
import { DirectoryPanel } from './DirectoryPanel'
import { TaskPanel } from './TaskPanel'

/** M-001 验证界面：本机显式开启服务、授权独立接收目录并查看真实任务。 */
export function App(): React.JSX.Element {
  const isDarkMode = useSystemDarkMode()
  const api = window.desktopService
  const [snapshot, setSnapshot] = useState<DesktopServiceSnapshot | null>(null)
  const [port, setPort] = useState<number | null>(0)
  const [error, setError] = useState('')
  const [isBusy, setIsBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!api) return
    const service = api
    let isCurrent = true
    let timer: ReturnType<typeof setTimeout>
    async function poll(): Promise<void> {
      try {
        const result = await service.status()
        if (!isCurrent) return
        if (result.status === 'success') setSnapshot(result.value)
        else setError(result.error.message)
      } catch {
        if (isCurrent) setError('无法读取本地服务状态。')
      } finally {
        if (isCurrent)
          timer = setTimeout(() => {
            poll().catch(() => setError('状态刷新失败。'))
          }, 1000)
      }
    }
    poll().catch(() => setError('读取服务状态失败。'))
    return () => {
      isCurrent = false
      clearTimeout(timer)
    }
  }, [api])
  function run(work: () => Promise<OperationResult<DesktopServiceSnapshot>>): void {
    if (isBusy) return
    setIsBusy(true)
    setError('')
    work()
      .then((result) => {
        if (result.status === 'success') setSnapshot(result.value)
        else setError(result.error.message)
      })
      .catch(() => setError('操作失败，请重新读取状态。'))
      .finally(() => setIsBusy(false))
  }
  function chooseTarget(): void {
    if (!api || isBusy) return
    setIsBusy(true)
    setError('')
    api
      .chooseTarget()
      .then((result) => {
        if (result.status === 'error') setError(result.error.message)
        if (result.status === 'selected') setRevision((value) => value + 1)
      })
      .catch(() => setError('接收目录授权失败。'))
      .finally(() => setIsBusy(false))
  }
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{ algorithm: isDarkMode ? theme.darkAlgorithm : theme.defaultAlgorithm }}
    >
      <Layout className="app-shell">
        <Layout.Content className="app-content">
          <header className="page-header">
            <div>
              <Typography.Title level={2}>{APP_NAME}</Typography.Title>
              <Typography.Text type="secondary">目录与文件往返验证</Typography.Text>
            </div>
            <Tag>M-001</Tag>
          </header>
          {!api && <Alert type="info" title="请在桌面应用中选择目录和启动服务。" showIcon />}
          {error && (
            <Alert type="error" title={error} closable={{ onClose: () => setError('') }} showIcon />
          )}
          <Card
            title="局域网连接"
            extra={
              <Tag color={snapshot?.listener ? 'success' : 'default'}>
                {snapshot?.listener ? '服务运行中' : '服务已停止'}
              </Tag>
            }
          >
            <Space wrap>
              <label htmlFor="listen-port">监听端口</label>
              <InputNumber
                id="listen-port"
                min={0}
                max={65535}
                precision={0}
                value={port}
                disabled={Boolean(snapshot?.listener) || isBusy}
                onChange={setPort}
              />
              <Button
                type="primary"
                disabled={!api || isBusy || Boolean(snapshot?.listener) || port === null}
                onClick={() => {
                  if (api && port !== null) run(() => api.start(port))
                }}
              >
                启动服务
              </Button>
              <Button
                danger
                disabled={!api || isBusy}
                onClick={() => {
                  if (api) run(() => api.stop())
                }}
              >
                停止服务并取消任务
              </Button>
            </Space>
            <p className="muted">
              端口填 0 会分配可用端口。手机与电脑连到同一局域网，在手机输入下方地址。
            </p>
            {snapshot?.listener && (
              <>
                <p>
                  监听 {snapshot.listener.host}:{snapshot.listener.port} · 明文 HTTP
                </p>
                {snapshot.listener.addresses.length > 0 ? (
                  snapshot.listener.addresses.map((address) => (
                    <p key={address}>
                      <Typography.Text copyable code>
                        {address}
                      </Typography.Text>
                    </p>
                  ))
                ) : (
                  <Alert type="warning" title="未找到局域网 IPv4 地址，请检查网络连接。" />
                )}
              </>
            )}
            {snapshot?.error && <Alert type="error" title={snapshot.error.message} showIcon />}
          </Card>
          <DirectoryPanel revision={revision} />
          <Card
            title="电脑接收目录"
            extra={
              <Button disabled={!api || isBusy} onClick={chooseTarget}>
                选择并允许接收
              </Button>
            }
          >
            <p className="muted">
              选择独立测试目录，允许手机在其中创建新文件。同名文件会拒绝接收，真实存档请用上方只读入口。
            </p>
            {snapshot?.targets.length ? (
              snapshot.targets.map((root) => (
                <div className="target-row" key={root.rootId}>
                  <span>{root.displayName}</span>
                  <Button
                    size="small"
                    disabled={isBusy}
                    onClick={() => {
                      if (api) run(() => api.revokeTarget(root.rootId))
                    }}
                  >
                    撤销接收授权
                  </Button>
                </div>
              ))
            ) : (
              <p>尚未授权接收目录</p>
            )}
          </Card>
          <section className="task-section" aria-label="传输任务">
            <div className="section-heading">
              <Typography.Title level={4}>本次服务的任务</Typography.Title>
              <Button
                disabled={!api || isBusy}
                onClick={() => {
                  if (api) run(() => api.retryCleanup())
                }}
              >
                重试临时文件清理
              </Button>
            </div>
            <p className="muted">在手机选择源文件和目标位置，发起任一方向的传输。</p>
            {snapshot?.tasks.length ? (
              [...snapshot.tasks].reverse().map((state) => (
                <TaskPanel
                  key={state.transferId}
                  state={state}
                  isBusy={isBusy}
                  onCancel={() => {
                    if (api) run(() => api.cancel(state.transferId))
                  }}
                />
              ))
            ) : (
              <Card>
                <p>本次服务还没有传输任务</p>
              </Card>
            )}
          </section>
        </Layout.Content>
      </Layout>
    </ConfigProvider>
  )
}
