import { useEffect, useState } from 'react'
import { Button, Card, Checkbox, Dialog } from 'antd-mobile'
import type { DirectoryListing, DirectoryReference, FileMetadata } from '@savedata-sync/shared'
import type { AndroidDirectoryApi } from './saf-directory-bridge'
import { formatBytes, formatDate } from './display'

/** 当前可操作的一层；读取失败时整个位置失效，避免用旧列表发起传输。 */
export interface DirectoryLocation {
  readonly rootId: string
  readonly parentId: string | null
  readonly label: string
  readonly listing: DirectoryListing
  readonly files: readonly FileMetadata[]
}
interface Crumb {
  readonly id: string
  readonly name: string
}
interface DirectoryPanelProps {
  readonly title: string
  readonly api: AndroidDirectoryApi
  readonly isSource: boolean
  readonly isDisabled: boolean
  readonly isWriteTarget?: boolean
  readonly canChoose: boolean
  readonly onChange: (location: DirectoryLocation | null) => void
  readonly onGrant?: (rootId: string) => void
}

/** 系统选择器、当前层浏览及显式文件选择；目录只在点击进入时读取下一层。 */
export function DirectoryPanel({
  title,
  api,
  isSource,
  isDisabled,
  isWriteTarget = false,
  canChoose,
  onChange,
  onGrant,
}: DirectoryPanelProps): React.JSX.Element {
  const [roots, setRoots] = useState<readonly DirectoryReference[]>([])
  const [rootId, setRootId] = useState('')
  const [crumbs, setCrumbs] = useState<readonly Crumb[]>([])
  const [listing, setListing] = useState<DirectoryListing | null>(null)
  const [selected, setSelected] = useState<readonly string[]>([])
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isChoosing, setIsChoosing] = useState(false)
  const [revision, setRevision] = useState(0)
  const [listingRevision, setListingRevision] = useState(0)
  const parentId = crumbs.at(-1)?.id ?? null
  const label = [
    roots.find((root) => root.rootId === rootId)?.displayName ?? '未选择目录',
    ...crumbs.map((item) => item.name),
  ].join(' / ')
  useEffect(() => {
    let isCurrent = true
    api
      .listRoots()
      .then((result) => {
        if (!isCurrent) return
        if (result.status === 'error') {
          setError(`${result.error.message}（${result.error.code}）`)
          setRoots([])
          setRootId('')
          return
        }
        setRoots(result.value)
        setListingRevision((value) => value + 1)
        setRootId((id) =>
          result.value.some((root) => root.rootId === id) ? id : (result.value[0]?.rootId ?? ''),
        )
      })
      .catch(() => {
        if (isCurrent) setError('读取目录列表失败。')
      })
    return () => {
      isCurrent = false
    }
  }, [api, revision])
  useEffect(() => {
    setListing(null)
    setSelected([])
    if (!rootId) return
    let isCurrent = true
    setIsLoading(true)
    setError('')
    // 远端刷新根列表会清空条目引用；依次重读祖先，恢复当前父目录的有效引用。
    async function readCurrent(): Promise<
      Awaited<ReturnType<AndroidDirectoryApi['listDirectory']>>
    > {
      for (const ancestor of [null, ...crumbs.slice(0, -1).map((crumb) => crumb.id)]) {
        if (parentId === null) break
        const result = await api.listDirectory(rootId, ancestor)
        if (result.status === 'error' || !isCurrent) return result
      }
      return api.listDirectory(rootId, parentId)
    }
    readCurrent()
      .then((result) => {
        if (!isCurrent) return
        if (result.status === 'success') setListing(result.value)
        else setError(`${result.error.message}（${result.error.code}）`)
      })
      .catch(() => {
        if (isCurrent) setError('读取目录失败，请刷新或重新选择。')
      })
      .finally(() => {
        if (isCurrent) setIsLoading(false)
      })
    return () => {
      isCurrent = false
    }
  }, [api, rootId, parentId, crumbs, listingRevision])
  useEffect(() => {
    onChange(
      listing && listing.rootId === rootId && listing.parentId === parentId
        ? {
            rootId,
            parentId,
            label,
            listing,
            files: listing.entries.filter(
              (entry): entry is FileMetadata =>
                entry.kind === 'file' && selected.includes(entry.entryId),
            ),
          }
        : null,
    )
  }, [listing, rootId, parentId, label, selected, onChange])
  async function choose(): Promise<void> {
    setIsChoosing(true)
    try {
      if (
        isWriteTarget &&
        !(await Dialog.confirm({
          title: '选择独立测试目录',
          content: '允许在所选目录及子目录中创建新文件。同名文件会拒绝接收，请勿选择真实游戏存档。',
          confirmText: '继续选择',
        }))
      )
        return
      const result = await api.chooseDirectory()
      if (result.status === 'error') setError(`${result.error.message}（${result.error.code}）`)
      if (result.status === 'selected') {
        if (isWriteTarget) onGrant?.(result.directory.rootId)
        setCrumbs([])
        setRootId(result.directory.rootId)
        setRevision((value) => value + 1)
      }
    } finally {
      setIsChoosing(false)
    }
  }
  return (
    <Card
      title={title}
      extra={<span className="role-label">{isSource ? '源：选择文件' : '目标：当前目录'}</span>}
    >
      <div className="button-row">
        {canChoose && (
          <Button
            size="small"
            disabled={isDisabled}
            loading={isChoosing}
            onClick={() => choose().catch(() => setError('选择目录失败。'))}
          >
            {isWriteTarget ? '选择并允许接收' : '选择只读目录'}
          </Button>
        )}
        <Button
          size="small"
          disabled={isDisabled || isLoading}
          onClick={() => setRevision((value) => value + 1)}
        >
          刷新
        </Button>
        <Button
          size="small"
          disabled={isDisabled || isLoading || crumbs.length === 0}
          onClick={() => setCrumbs((items) => items.slice(0, -1))}
        >
          上一级
        </Button>
      </div>
      <label className="field-label">
        根目录
        <select
          aria-label={`${title}根目录`}
          disabled={isDisabled || isLoading}
          value={rootId}
          onChange={(event) => {
            setCrumbs([])
            setRootId(event.target.value)
          }}
        >
          <option value="" disabled>
            请选择目录
          </option>
          {roots.map((root) => (
            <option key={root.rootId} value={root.rootId}>
              {root.displayName}
              {root.authorization === 'granted' ? '' : ' · 需核实授权'}
            </option>
          ))}
        </select>
      </label>
      <p className="directory-path">{label}</p>
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
      {isLoading && <p className="muted">读取中…</p>}
      {!isLoading && !error && listing?.entries.length === 0 && <p className="muted">空目录</p>}
      {!rootId && !error && (
        <p className="muted">{canChoose ? '先选择目录' : '请先在电脑选择目录，再刷新'}</p>
      )}
      <div className="entry-list">
        {listing?.entries.map((entry) => (
          <div className="entry-row" key={entry.entryId}>
            <div className="entry-name">
              {entry.kind === 'directory' ? (
                <Button
                  size="small"
                  fill="none"
                  color="primary"
                  disabled={isDisabled || isLoading}
                  onClick={() =>
                    setCrumbs((items) => [...items, { id: entry.entryId, name: entry.name }])
                  }
                >
                  {entry.name} /
                </Button>
              ) : isSource ? (
                <Checkbox
                  checked={selected.includes(entry.entryId)}
                  disabled={isDisabled || isLoading || entry.capabilities.canRead === 'unsupported'}
                  onChange={(checked) =>
                    setSelected((items) =>
                      checked
                        ? [...items, entry.entryId]
                        : items.filter((id) => id !== entry.entryId),
                    )
                  }
                >
                  {entry.name}
                </Checkbox>
              ) : (
                <span>{entry.name}</span>
              )}
            </div>
            <p className="entry-meta">
              {entry.kind === 'directory' ? '文件夹 · —' : `文件 · ${formatBytes(entry.sizeBytes)}`}{' '}
              · {formatDate(entry.modifiedAt)}
            </p>
          </div>
        ))}
      </div>
      {listing && (
        <p className="muted">
          读取时间：{formatDate(listing.observedAt)} · 当前层 {listing.entries.length} 项
          {isSource ? ` · 已选 ${selected.length} 个文件` : ''}
        </p>
      )}
    </Card>
  )
}
