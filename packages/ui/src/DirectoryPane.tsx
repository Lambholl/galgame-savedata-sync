import { useEffect, useState } from 'react'
import { Alert, Button, Empty, Space, Table } from 'antd'
import { ArrowUpOutlined, FolderOutlined, ReloadOutlined } from '@ant-design/icons'
import type {
  DirectoryListing,
  DirectoryReference,
  EntryMetadata,
  FileMetadata,
} from '@savedata-sync/shared'
import { displayBytes, displayTime, unwrap } from './api.ts'
import type { UiAdapter } from './api.ts'

/** 当前层读取与选择；失败时向父页面回报 null，禁止沿用旧选择。 */
export interface PaneLocation {
  readonly rootId: string
  readonly parentId: string | null
  readonly listing: DirectoryListing
  readonly files: readonly FileMetadata[]
}
interface Props {
  readonly adapter: UiAdapter
  readonly deviceId: string | null
  readonly root: DirectoryReference | null
  readonly title: string
  readonly isSource: boolean
  readonly isDisabled: boolean
  readonly isOnline: boolean
  readonly onLocation: (value: PaneLocation | null) => void
}
/** 两端共用的紧凑目录列；只展开点击的文件夹，不汇总目录大小。 */
export function DirectoryPane({
  adapter,
  deviceId,
  root,
  title,
  isSource,
  isDisabled,
  isOnline,
  onLocation,
}: Props): React.JSX.Element {
  const [crumbs, setCrumbs] = useState<readonly { id: string; name: string }[]>([])
  const [listing, setListing] = useState<DirectoryListing | null>(null)
  const [selected, setSelected] = useState<readonly string[]>([])
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [revision, setRevision] = useState(0)
  const rootId = root?.rootId ?? null
  const parentId = crumbs.at(-1)?.id ?? null
  useEffect(() => {
    setListing(null)
    setSelected([])
    setError('')
    if (!rootId || !isOnline) {
      return
    }
    let isCurrent = true
    setIsLoading(true)
    async function read(): Promise<void> {
      for (const ancestor of [null, ...crumbs.slice(0, -1).map((item) => item.id)]) {
        if (parentId === null) {
          break
        }
        unwrap(await adapter.directory(deviceId, rootId as string, ancestor))
        if (!isCurrent) {
          return
        }
      }
      const value = unwrap(await adapter.directory(deviceId, rootId as string, parentId))
      if (isCurrent) {
        setListing(value)
        setSelected(
          value.entries
            .filter((item) => item.kind === 'file' && item.capabilities.canRead !== 'unsupported')
            .map((item) => item.entryId),
        )
      }
    }
    read()
      .catch((cause: unknown) => {
        if (isCurrent) {
          setError(cause instanceof Error ? cause.message : '读取目录失败。')
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
  }, [adapter, deviceId, rootId, parentId, crumbs, revision, isOnline])
  useEffect(() => {
    onLocation(
      listing && rootId && isOnline
        ? {
          rootId,
          parentId,
          listing,
          files: listing.entries.filter(
            (item): item is FileMetadata =>
              item.kind === 'file' && selected.includes(item.entryId),
          ),
        }
        : null,
    )
  }, [listing, rootId, parentId, selected, isOnline, onLocation])
  return (
    <section className="library-pane" aria-label={title}>
      <div className="library-pane-head">
        <div>
          <strong>{title}</strong>
          <span>{isSource ? '源' : '目标'}</span>
        </div>
        <p
          title={[root?.displayName, ...crumbs.map((item) => item.name)]
            .filter(Boolean)
            .join(' / ')}
        >
          {[root?.displayName ?? '未设置目录', ...crumbs.map((item) => item.name)].join(' / ')}
        </p>
        <Space size={4}>
          <Button
            size="small"
            icon={<ArrowUpOutlined />}
            aria-label={`${title}上一级`}
            disabled={!crumbs.length || isLoading}
            onClick={() => setCrumbs((items) => items.slice(0, -1))}
          />
          <Button
            size="small"
            icon={<ReloadOutlined />}
            aria-label={`${title}刷新`}
            disabled={!rootId || !isOnline || isLoading}
            onClick={() => setRevision((value) => value + 1)}
          />
        </Space>
      </div>
      {error && <Alert type="error" title={error} showIcon />}
      <Table<EntryMetadata>
        size="small"
        rowKey="entryId"
        showHeader={false}
        pagination={false}
        scroll={{ y: 300 }}
        loading={isLoading}
        dataSource={listing ? [...listing.entries] : []}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                !isOnline ? '设备未连接' : !root ? '未设置目录' : error ? '读取失败' : '空目录'
              }
            />
          ),
        }}
        {...(isSource
          ? {
            rowSelection: {
              columnWidth: 26,
              selectedRowKeys: [...selected],
              getCheckboxProps: (item: EntryMetadata) => ({
                disabled:
                    isDisabled ||
                    item.kind !== 'file' ||
                    item.capabilities.canRead === 'unsupported',
              }),
              onChange: (keys: React.Key[]) => setSelected(keys.map(String)),
            },
          }
          : {})}
        columns={[
          {
            key: 'entry',
            dataIndex: 'name',
            render: (name: string, item) => (
              <div className="library-entry">
                {item.kind === 'directory' ? (
                  <Button
                    size="small"
                    icon={<FolderOutlined />}
                    onClick={() =>
                      setCrumbs((items) => [...items, { id: item.entryId, name: item.name }])
                    }
                    title={item.name}
                  >
                    {item.name}
                  </Button>
                ) : (
                  <strong title={name}>{name}</strong>
                )}
                <small>{item.kind === 'directory' ? '—' : displayBytes(item.sizeBytes)}</small>
                <time>{displayTime(item.modifiedAt)}</time>
              </div>
            ),
          },
        ]}
      />
    </section>
  )
}
