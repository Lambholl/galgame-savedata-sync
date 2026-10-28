import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Empty, Space, Table } from 'antd'
import { unwrap } from '@savedata-sync/shared'
import type { SyncEntry, SyncScanState } from '@savedata-sync/shared'
import type { DesktopServiceApi } from '../../../../bridge/service-bridge.ts'
import { displayBytes, displayTime } from '../../components/display.ts'

/** 重扫只读本机当前目录；不修改确认计划或发起跨端复制。 */
export function SyncScanPanel({
  rootId,
  isDisabled,
}: {
  readonly rootId: string
  readonly isDisabled: boolean
}): React.JSX.Element {
  const [state, setState] = useState<SyncScanState | null>(null),
    [error, setError] = useState(''),
    [isBusy, setIsBusy] = useState(false),
    [isWatching, setIsWatching] = useState(false)
  const generation = useRef(0),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const invalidate = useCallback(() => {
    generation.current++
  }, [])
  useEffect(() => {
    invalidate()
    setState(null)
    setError('')
    setIsBusy(false)
    setIsWatching(false)
    return () => {
      invalidate()
      if (timer.current) {
        clearTimeout(timer.current)
      }
    }
  }, [rootId, invalidate])
  async function watch(api: DesktopServiceApi, id: string, current: number): Promise<void> {
    try {
      const next = unwrap(await api.queryScan(id))
      if (generation.current !== current) {
        return
      }
      setState(next)
      setIsWatching(next.status === 'running')
      if (next.status === 'running') {
        timer.current = setTimeout(() => {
          void watch(api, id, current).catch((cause: unknown) => {
            if (generation.current === current) {
              setIsWatching(false)
              setError(cause instanceof Error ? cause.message : '扫描状态读取失败。')
            }
          })
        }, 600)
      }
    } catch (cause) {
      if (generation.current === current) {
        setIsWatching(false)
        setError(cause instanceof Error ? cause.message : '扫描状态读取失败。')
      }
    }
  }
  function start(): void {
    const api = window.desktopService
    if (!api || isBusy || isWatching) {
      return
    }
    const current = ++generation.current
    setIsBusy(true)
    setError('')
    if (state?.status === 'running') {
      void watch(api, state.scanId, current)
        .finally(() => {
          if (generation.current === current) {
            setIsBusy(false)
          }
        })
        .catch((cause: unknown) => {
          if (generation.current === current) {
            setError(cause instanceof Error ? cause.message : '扫描状态读取失败。')
          }
        })
      return
    }
    api
      .startScan(rootId)
      .then(async (result) => {
        const next = unwrap(result)
        if (generation.current !== current) {
          return
        }
        setState(next)
        setIsWatching(next.status === 'running')
        if (next.status === 'running') {
          await watch(api, next.scanId, current)
        }
      })
      .catch((cause: unknown) => {
        if (generation.current === current) {
          setError(cause instanceof Error ? cause.message : '目录读取失败。')
        }
      })
      .finally(() => {
        if (generation.current === current) {
          setIsBusy(false)
        }
      })
  }
  function cancel(): void {
    const api = window.desktopService
    if (!api || !state) {
      return
    }
    const current = ++generation.current
    if (timer.current) {
      clearTimeout(timer.current)
    }
    setError('')
    setIsBusy(true)
    void api
      .cancelScan(state.scanId)
      .then(async (result) => {
        const next = unwrap(result)
        if (generation.current !== current) {
          return
        }
        setState(next)
        setIsWatching(next.status === 'running')
        if (next.status === 'running') {
          await watch(api, next.scanId, current)
        }
      })
      .catch((cause: unknown) => {
        if (generation.current === current) {
          setIsWatching(false)
          setError(cause instanceof Error ? cause.message : '取消读取失败。')
        }
      })
      .finally(() => {
        if (generation.current === current) {
          setIsBusy(false)
        }
      })
  }
  const snapshot = state?.snapshot
  return (
    <Card size="small" title="当前电脑目录">
      <div className="library-stack">
        <Space wrap>
          <Button disabled={isDisabled || isBusy || isWatching} onClick={start}>
            {state?.status === 'running' && error ? '重新查询扫描' : '重扫本机目录'}
          </Button>
          {state?.status === 'running' && (
            <Button disabled={isBusy} onClick={cancel}>
              取消扫描
            </Button>
          )}
        </Space>
        {error && <Alert showIcon type="error" title={error} />}
        {state?.status === 'running' && isWatching && (
          <p>正在读取，已扫描 {state.scannedEntries} 项。</p>
        )}
        {state?.status === 'failed' && (
          <Alert showIcon type="error" title={state.error?.message ?? '目录扫描未完成。'} />
        )}
        {state?.status === 'cancelled' && <Alert type="info" title="本次扫描已取消" />}
        {snapshot && snapshot.entries.length > 0 && (
          <Table<SyncEntry>
            size="small"
            dataSource={[...snapshot.entries]}
            rowKey="entryId"
            pagination={{ defaultPageSize: 20, hideOnSinglePage: true }}
            scroll={{ x: 560 }}
            columns={[
              {
                title: '相对位置',
                key: 'path',
                render: (_, item) => (
                  <span className="library-sync-path">{item.path.join(' / ')}</span>
                ),
              },
              {
                title: '类型',
                key: 'kind',
                render: (_, item) => (item.kind === 'directory' ? '文件夹' : '文件'),
              },
              {
                title: '文件大小',
                key: 'size',
                render: (_, item) =>
                  item.kind === 'directory' ? '—' : displayBytes(item.sizeBytes),
              },
              {
                title: '修改时间',
                key: 'modified',
                render: (_, item) => displayTime(item.modifiedAt),
              },
              {
                title: '读取情况',
                key: 'error',
                render: (_, item) => item.error?.message ?? '已读取',
              },
            ]}
          />
        )}
        {state?.status === 'succeeded' && snapshot?.entries.length === 0 && (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前目录为空" />
        )}
      </div>
    </Card>
  )
}
