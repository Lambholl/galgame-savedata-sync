import { useEffect, useState } from 'react'
import { Alert, Button, Card, Select, Space, Table, Typography } from 'antd'
import type { DirectoryListing, DirectoryReference, EntryMetadata } from '@savedata-sync/shared'
import { formatBytes, formatDate } from './display'

interface Crumb {
  readonly id: string
  readonly name: string
}

/** 当前层浏览器；只在进入目录或刷新时读取，不请求内容或递归统计。 */
export function DirectoryPanel({ revision }: { readonly revision: number }): React.JSX.Element {
  const api = window.desktopDirectories
  const [roots, setRoots] = useState<readonly DirectoryReference[]>([])
  const [rootId, setRootId] = useState('')
  const [crumbs, setCrumbs] = useState<readonly Crumb[]>([])
  const [listing, setListing] = useState<DirectoryListing | null>(null)
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isChoosing, setIsChoosing] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const parentId = crumbs.at(-1)?.id ?? null
  useEffect(() => {
    if (!api) {
      return
    }
    let isCurrent = true
    api
      .listRoots()
      .then((result) => {
        if (!isCurrent) {
          return
        }
        if (result.status === 'error') {
          setError(result.error.message)
          return
        }
        setRoots(result.value)
        setRootId((id) =>
          result.value.some((root) => root.rootId === id) ? id : (result.value[0]?.rootId ?? ''),
        )
      })
      .catch(() => {
        if (isCurrent) {
          setError('读取目录列表失败。')
        }
      })
    return () => {
      isCurrent = false
    }
  }, [api, revision, refresh])
  useEffect(() => {
    setListing(null)
    if (!api || !rootId) {
      return
    }
    let isCurrent = true
    setIsLoading(true)
    setError('')
    api
      .listDirectory(rootId, parentId)
      .then((result) => {
        if (!isCurrent) {
          return
        }
        if (result.status === 'success') {
          setListing(result.value)
        } else {
          setError(`${result.error.message}（${result.error.code}）`)
        }
      })
      .catch(() => {
        if (isCurrent) {
          setError('读取目录失败，请刷新。')
        }
      })
      .finally(() => {
        if (isCurrent) {
          setIsLoading(false)
        }
      })
    return () => {
      isCurrent = false
    }
  }, [api, rootId, parentId, refresh])
  async function choose(): Promise<void> {
    if (!api || isChoosing) {
      return
    }
    setIsChoosing(true)
    try {
      const result = await api.chooseDirectory()
      if (result.status === 'error') {
        setError(result.error.message)
      }
      if (result.status === 'selected') {
        setCrumbs([])
        setRootId(result.directory.rootId)
        setRefresh((value) => value + 1)
      }
    } finally {
      setIsChoosing(false)
    }
  }
  return (
    <Card
      title="电脑目录"
      extra={
        <Button
          disabled={!api}
          loading={isChoosing}
          onClick={() => {
            choose().catch(() => setError('选择目录失败。'))
          }}
        >
          选择只读目录
        </Button>
      }
    >
      <Space wrap className="directory-toolbar">
        <Select
          aria-label="电脑根目录"
          placeholder="先选择目录"
          value={rootId || null}
          style={{ minWidth: 260 }}
          options={roots.map((root) => ({
            value: root.rootId,
            label: `${root.displayName}${root.authorization === 'granted' ? '' : ' · 需核实授权'}`,
          }))}
          onChange={(id: string) => {
            setCrumbs([])
            setRootId(id)
          }}
        />
        <Button disabled={!api || isLoading} onClick={() => setRefresh((value) => value + 1)}>
          刷新
        </Button>
        <Button
          disabled={crumbs.length === 0 || isLoading}
          onClick={() => setCrumbs((items) => items.slice(0, -1))}
        >
          上一级
        </Button>
      </Space>
      <p className="directory-path">
        {[
          roots.find((root) => root.rootId === rootId)?.displayName ?? '未选择目录',
          ...crumbs.map((item) => item.name),
        ].join(' / ')}
      </p>
      {error && <Alert type="error" title={error} showIcon />}
      <Table<EntryMetadata>
        rowKey="entryId"
        size="small"
        loading={isLoading}
        dataSource={listing ? [...listing.entries] : []}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        locale={{
          emptyText: error
            ? '读取失败，请检查授权或重新选择目录'
            : !rootId
              ? '选择目录后查看文件'
              : listing
                ? '空目录'
                : '正在读取目录',
        }}
        columns={[
          {
            title: '名称',
            dataIndex: 'name',
            key: 'name',
            render: (name: string, entry) =>
              entry.kind === 'directory' ? (
                <Button
                  type="link"
                  onClick={() =>
                    setCrumbs((items) => [...items, { id: entry.entryId, name: entry.name }])
                  }
                >
                  {entry.name} /
                </Button>
              ) : (
                name
              ),
          },
          {
            title: '类型',
            dataIndex: 'kind',
            key: 'kind',
            render: (kind: string) => (kind === 'directory' ? '文件夹' : '文件'),
            width: 80,
          },
          {
            title: '大小',
            dataIndex: 'sizeBytes',
            key: 'size',
            render: (bytes: number | null, entry) =>
              entry.kind === 'directory' ? '—' : formatBytes(bytes),
            width: 120,
          },
          {
            title: '修改日期',
            dataIndex: 'modifiedAt',
            key: 'modified',
            render: formatDate,
            width: 190,
          },
        ]}
      />
      {listing && (
        <Typography.Text type="secondary">
          读取时间：{formatDate(listing.observedAt)} · 当前层 {listing.entries.length} 项
        </Typography.Text>
      )}
    </Card>
  )
}
