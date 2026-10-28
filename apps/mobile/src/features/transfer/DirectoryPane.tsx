import { useEffect, useRef, useState } from 'react'
import { Button, SpinLoading } from 'antd-mobile'
import { FileOutlined, FolderOutlined, ReloadOutlined } from '@ant-design/icons'
import { unwrap } from '@savedata-sync/shared'
import type { DirectoryListing, DirectoryReference, EntryMetadata } from '@savedata-sync/shared'
import type { MobileLibraryAdapter } from '../../platform/library-types'
import { displayFileBytes, displayFileTime } from './display'

function EntryContent({ entry }: { readonly entry: EntryMetadata }): React.JSX.Element {
  return (
    <>
      <span className={`entry-icon ${entry.kind}`} aria-hidden="true">
        {entry.kind === 'directory' ? <FolderOutlined /> : <FileOutlined />}
      </span>
      <span className="entry-content">
        <span className="entry-name">{entry.name}</span>
        <span className="entry-meta">
          <time>{displayFileTime(entry.modifiedAt)}</time>
          {entry.kind === 'file' && <span>{displayFileBytes(entry.sizeBytes)}</span>}
        </span>
      </span>
    </>
  )
}

/** 两列独立只读浏览，点文件只高亮；刷新逐层重取引用，迟到请求不覆盖当前路径。 */
export function DirectoryPane({
  adapter,
  deviceId,
  root,
  title,
  isSource,
  isDisabled,
  isOnline,
}: {
  readonly adapter: MobileLibraryAdapter
  readonly deviceId: string | null
  readonly root: DirectoryReference | null
  readonly title: string
  readonly isSource: boolean
  readonly isDisabled: boolean
  readonly isOnline: boolean
}): React.JSX.Element {
  const [crumbs, setCrumbs] = useState<readonly string[]>([])
  const [loaded, setLoaded] = useState<{ key: string; listing: DirectoryListing } | null>(null)
  const [selected, setSelected] = useState<readonly string[]>([])
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [revision, setRevision] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  const rootId = root?.rootId ?? null
  const authorization = root?.authorization
  const locationKey = JSON.stringify([deviceId, rootId, authorization, crumbs, revision, isOnline])
  const listing = loaded?.key === locationKey && isOnline ? loaded.listing : null
  useEffect(() => {
    let isCurrent = true
    setLoaded(null)
    setSelected([])
    setError('')
    list.current?.scrollTo({ top: 0 })
    if (!rootId || !isOnline) {
      setIsLoading(false)
      return
    }
    const currentRootId = rootId
    setIsLoading(true)
    async function read(): Promise<void> {
      let value = unwrap(await adapter.directory(deviceId, currentRootId, null))
      for (const name of crumbs) {
        if (!isCurrent) {
          return
        }
        const directories = value.entries.filter(
          (entry) => entry.kind === 'directory' && entry.name === name,
        )
        const directory = directories[0]
        if (directories.length !== 1 || !directory) {
          throw new Error('当前文件夹已变化，请返回上一级后刷新。')
        }
        value = unwrap(await adapter.directory(deviceId, currentRootId, directory.entryId))
      }
      if (isCurrent) {
        setLoaded({ key: locationKey, listing: value })
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
  }, [adapter, deviceId, rootId, crumbs, revision, isOnline, authorization, locationKey])
  const fileCount = listing?.entries.filter((entry) => entry.kind === 'file').length ?? 0
  const folderCount = (listing?.entries.length ?? 0) - fileCount
  function navigate(next: readonly string[]): void {
    setSelected([])
    setCrumbs(next)
  }
  function select(entryId: string): void {
    setSelected((items) =>
      items.includes(entryId) ? items.filter((id) => id !== entryId) : [...items, entryId],
    )
  }
  return (
    <section className="directory-pane" aria-label={title}>
      <div className="pane-heading">
        <div className="pane-caption">
          <strong>{title}</strong>
          <span className="pane-role">{isSource ? '来源' : '目标'}</span>
        </div>
        <Button
          fill="none"
          aria-label={`${title}刷新`}
          disabled={isDisabled || !rootId || !isOnline || isLoading}
          onClick={() => setRevision((value) => value + 1)}
        >
          <ReloadOutlined />
        </Button>
      </div>
      <div className="pane-list" ref={list} aria-busy={isLoading}>
        {crumbs.length > 0 && (
          <button
            type="button"
            className="directory-entry parent-entry"
            aria-label={`${title}上一级`}
            disabled={isDisabled || isLoading}
            onClick={() => navigate(crumbs.slice(0, -1))}
          >
            <span className="entry-icon directory" aria-hidden="true">
              <FolderOutlined />
            </span>
            <span className="entry-name">..</span>
          </button>
        )}
        {isLoading && (
          <div className="pane-empty">
            <SpinLoading style={{ '--size': '20px' }} />
            <span>读取中</span>
          </div>
        )}
        {error && (
          <p className="pane-error" role="alert">
            {error}
          </p>
        )}
        {!isLoading &&
          listing?.entries.map((entry) => (
            <button
              type="button"
              key={entry.entryId}
              className={`directory-entry${entry.kind === 'file' && selected.includes(entry.entryId) ? ' is-selected' : ''}`}
              aria-pressed={entry.kind === 'file' ? selected.includes(entry.entryId) : undefined}
              disabled={
                isDisabled ||
                (entry.kind === 'directory' && entry.capabilities.canList === 'unsupported')
              }
              onClick={() =>
                entry.kind === 'directory'
                  ? navigate([...crumbs, entry.name])
                  : select(entry.entryId)
              }
            >
              <EntryContent entry={entry} />
            </button>
          ))}
        {!isLoading && !error && (!root || !isOnline || listing?.entries.length === 0) && (
          <p className="pane-empty">{!root ? '未设置目录' : !isOnline ? '设备未连接' : '空目录'}</p>
        )}
      </div>
      <p className="pane-count">
        {listing
          ? `文件夹 ${folderCount} · 文件 ${fileCount}${selected.length > 0 ? ` · 已选 ${selected.length}` : ''}`
          : isLoading
            ? '读取中'
            : '未读取'}
      </p>
    </section>
  )
}
