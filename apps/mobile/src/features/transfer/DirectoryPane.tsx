import { useEffect, useState } from 'react'
import { Button, Checkbox, SpinLoading } from 'antd-mobile'
import { ArrowUpOutlined, ReloadOutlined, FolderOutlined, FileOutlined } from '@ant-design/icons'
import { unwrap } from '@savedata-sync/shared'
import type {
  DirectoryListing,
  DirectoryLocation,
  DirectoryReference,
  EntryMetadata,
  FileMetadata,
} from '@savedata-sync/shared'
import type { MobileLibraryAdapter } from '../../platform/library-types'
import { displayBytes, displayTime } from './display'

interface Props {
  readonly adapter: MobileLibraryAdapter
  readonly deviceId: string | null
  readonly root: DirectoryReference | null
  readonly title: string
  readonly isSource: boolean
  readonly isDisabled: boolean
  readonly isOnline: boolean
  readonly onLocation: (value: DirectoryLocation | null) => void
}

function EntryContent({ entry }: { readonly entry: EntryMetadata }): React.JSX.Element {
  return (
    <span className="entry-content">
      <span className="entry-name">
        {entry.kind === 'directory' ? <FolderOutlined /> : <FileOutlined />}
        <strong>{entry.name}</strong>
      </span>
      <span className="entry-size">
        {entry.kind === 'directory' ? '文件夹' : displayBytes(entry.sizeBytes)}
      </span>
      <time>{displayTime(entry.modifiedAt)}</time>
    </span>
  )
}

/** 每列独立读取和滚动；目录身份改变后立即丢弃旧列表与选择，迟到请求不写回。 */
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
  const [loaded, setLoaded] = useState<{ key: string; listing: DirectoryListing } | null>(null)
  const [selected, setSelected] = useState<readonly string[]>([])
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [revision, setRevision] = useState(0)
  const rootId = root?.rootId ?? null
  const parentId = crumbs.at(-1)?.id ?? null
  const locationKey = JSON.stringify([deviceId, rootId, parentId, revision, isOnline])
  const listing = loaded?.key === locationKey && isOnline ? loaded.listing : null
  useEffect(() => {
    setLoaded(null)
    setSelected([])
    setError('')
    onLocation(null)
    if (!rootId || !isOnline) {
      setIsLoading(false)
      return
    }
    const currentRootId = rootId
    let isCurrent = true
    setIsLoading(true)
    async function read(): Promise<void> {
      // 远端目录句柄依赖先读父目录，恢复层级时逐层获取。
      for (const ancestor of [null, ...crumbs.slice(0, -1).map((item) => item.id)]) {
        if (parentId === null) {
          break
        }
        unwrap(await adapter.directory(deviceId, currentRootId, ancestor))
        if (!isCurrent) {
          return
        }
      }
      const value = unwrap(await adapter.directory(deviceId, currentRootId, parentId))
      if (isCurrent) {
        setLoaded({ key: locationKey, listing: value })
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
  }, [adapter, deviceId, rootId, parentId, crumbs, revision, isOnline, locationKey, onLocation])
  useEffect(() => {
    onLocation(
      listing && rootId
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
  }, [listing, rootId, parentId, selected, onLocation])
  function navigate(next: readonly { id: string; name: string }[]): void {
    onLocation(null)
    setSelected([])
    setCrumbs(next)
  }
  return (
    <section className="directory-pane" aria-label={title}>
      <div className="pane-heading">
        <strong>{title}</strong>
        <span className="pane-role">{isSource ? '源' : '目标'}</span>
      </div>
      <p className="pane-path">
        {[root?.displayName ?? '未设置目录', ...crumbs.map((item) => item.name)].join(' / ')}
      </p>
      <div className="pane-toolbar">
        <Button
          fill="none"
          aria-label={`${title}上一级`}
          disabled={isDisabled || !crumbs.length || isLoading}
          onClick={() => navigate(crumbs.slice(0, -1))}
        >
          <ArrowUpOutlined />
        </Button>
        <Button
          fill="none"
          aria-label={`${title}刷新`}
          disabled={isDisabled || !rootId || !isOnline || isLoading}
          onClick={() => {
            onLocation(null)
            setRevision((value) => value + 1)
          }}
        >
          <ReloadOutlined />
        </Button>
      </div>
      <div className="pane-list" aria-busy={isLoading}>
        {isLoading && (
          <div className="pane-empty">
            <SpinLoading />
            <span>读取中</span>
          </div>
        )}
        {error && (
          <p className="pane-error" role="alert">
            {error}
          </p>
        )}
        {!isLoading &&
          listing?.entries.map((entry) =>
            entry.kind === 'directory' ? (
              <button
                type="button"
                className="directory-entry"
                key={entry.entryId}
                disabled={isDisabled}
                onClick={() => navigate([...crumbs, { id: entry.entryId, name: entry.name }])}
              >
                <EntryContent entry={entry} />
              </button>
            ) : isSource ? (
              <Checkbox
                block
                className="file-selection"
                key={entry.entryId}
                checked={selected.includes(entry.entryId)}
                disabled={isDisabled || entry.capabilities.canRead === 'unsupported'}
                onChange={(isChecked) =>
                  setSelected((items) =>
                    isChecked
                      ? [...items, entry.entryId]
                      : items.filter((id) => id !== entry.entryId),
                  )
                }
              >
                <EntryContent entry={entry} />
              </Checkbox>
            ) : (
              <div className="directory-entry" key={entry.entryId}>
                <EntryContent entry={entry} />
              </div>
            ),
          )}
        {!isLoading && !listing?.entries.length && !error && (
          <p className="pane-empty">{!isOnline ? '设备未连接' : !root ? '未设置目录' : '空目录'}</p>
        )}
      </div>
      <p className="pane-count">
        {isSource
          ? `已选 ${listing ? selected.length : 0} 个文件`
          : `当前层 ${listing?.entries.length ?? 0} 个条目`}
      </p>
    </section>
  )
}
