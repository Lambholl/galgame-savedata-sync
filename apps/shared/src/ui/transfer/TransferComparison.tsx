import { useState, type ReactElement } from 'react'
import {
  DesktopOutlined,
  DiffOutlined,
  DownOutlined,
  MobileOutlined,
  ReloadOutlined,
  SwapOutlined,
} from '@ant-design/icons'
import type { TransferDirection } from '../../protocol/contracts.ts'
import type { ShownError } from '../../result.ts'
import { comparisonChildren } from '../../sync/snapshot-compare.ts'
import type { CompareItem, CompareSide, SnapshotComparison } from '../../sync/snapshot-compare.ts'
import type { FileIconMarker } from '../files/FileIcon.tsx'
import { FilePane } from '../files/FilePane.tsx'
import type { PaneRow } from '../files/FilePane.tsx'
import { useT } from '../i18n/i18n-context.ts'
import { TransferStatus } from './TransferStatus.tsx'
import './transfer-comparison.css'

/** 方向条上一端的显示信息。 */
export interface TransferEndpoint {
  /** 主标题。 */
  readonly name: string
  /** 副标题；为空字符串时显示连接状态。 */
  readonly caption: string
  /** 是否在线，用状态点显示；为 null 时不显示状态点。 */
  readonly isOnline: boolean | null
  /** 该端存档目录的显示名，作为该列路径的起点。 */
  readonly rootName: string
}

/**
 * 两端比较的进度。
 * waiting：已发出请求，对端还没开始扫描；scanning：正在扫描两端；ready：比较完成；
 * cancelled：扫描已取消；failed：扫描失败，error 为 null 表示没有拿到原因；
 * unavailable：缺少设备、连接或目录等前提，reason 是给用户看的说明。
 */
export type ComparisonStatus =
  | { readonly kind: 'waiting' }
  | { readonly kind: 'scanning' }
  | { readonly kind: 'ready'; readonly comparison: SnapshotComparison }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly error: ShownError | null }
  | { readonly kind: 'unavailable'; readonly reason: string }

/** TransferComparison 的参数。 */
export interface TransferComparisonProps {
  /** 电脑一端。 */
  readonly pc: TransferEndpoint
  /** 移动端一端。 */
  readonly mobile: TransferEndpoint
  /** 哪一端是对端设备；点它的名称会调用 onPickPeer。 */
  readonly remoteSide: CompareSide
  /** 当前传输方向：来源一端排在左边，目标一端排在右边。 */
  readonly direction: TransferDirection
  /** 比较进度与结果。 */
  readonly status: ComparisonStatus
  /** 为 true 时禁用交换、切换设备和刷新（例如正在传输）。 */
  readonly isLocked: boolean
  /** 点中间的交换按钮：交换来源与目标。 */
  readonly onFlip: () => void
  /** 点按对端名称。 */
  readonly onPickPeer: () => void
  /** 重新扫描两端。 */
  readonly onRefresh: () => void
  /** 取消正在进行的扫描；不能取消时为 null，不显示取消按钮。 */
  readonly onCancel: (() => void) | null
  /** 目标多出的条目是否保留：false 时标红。 */
  readonly isKeepingExtras: boolean
  /** 切换保留开关；目标没有多出的条目时为 null，不显示开关。 */
  readonly onKeepExtrasChange: ((isKeeping: boolean) => void) | null
}

/**
 * 只在来源有的会在目标新建（绿色），只在目标有的保留（蓝色）或删除（红色），
 * 内容不同的会被覆盖（琥珀色）。
 */
function markerOf(item: CompareItem, isSource: boolean, isKeeping: boolean): FileIconMarker {
  if (item.state === 'only') {
    if (isSource) {
      return 'new'
    }
    return isKeeping ? 'only' : 'delete'
  }
  return item.state === 'same' ? 'none' : 'warn'
}

/** 重新扫描后文件夹可能已不存在：只保留新结果里仍然存在的那几层。 */
function existingPath(
  comparison: SnapshotComparison,
  side: CompareSide,
  path: readonly string[],
): readonly string[] {
  const result: string[] = []
  for (const name of path) {
    const isFound = comparisonChildren(comparison, side, result).some(
      (item) => item.kind === 'directory' && item.name === name,
    )
    if (!isFound) {
      break
    }
    result.push(name)
  }
  return result
}

function EndpointCard({
  side,
  endpoint,
  isSource,
  isRemote,
  isLocked,
  onPickPeer,
}: {
  readonly side: CompareSide
  readonly endpoint: TransferEndpoint
  readonly isSource: boolean
  readonly isRemote: boolean
  readonly isLocked: boolean
  readonly onPickPeer: () => void
}): ReactElement {
  const t = useT()
  const content = (
    <>
      <span className="ss-end-name">
        {side === 'pc' ? (
          <DesktopOutlined className="ss-end-icon" />
        ) : (
          <MobileOutlined className="ss-end-icon" />
        )}
        <span>{endpoint.name}</span>
        {isRemote && <DownOutlined className="ss-end-pick" />}
      </span>
      <span className="ss-end-caption">
        <span className={`ss-role ${isSource ? 'is-source' : 'is-target'}`}>
          {t(isSource ? 'transfer.source' : 'transfer.target')}
        </span>
        {endpoint.isOnline !== null && (
          <>
            <i className={`ss-dot${endpoint.isOnline ? ' is-on' : ''}`} />
            {t(endpoint.isOnline ? 'transfer.connected' : 'transfer.disconnected')}
          </>
        )}
        {endpoint.caption && <span className="ss-end-detail">{endpoint.caption}</span>}
      </span>
    </>
  )
  const className = `ss-end${isSource ? ' is-source' : ''}`
  return isRemote ? (
    <button
      type="button"
      className={`${className} ss-pressable`}
      disabled={isLocked}
      aria-label={`${t('transfer.pickPeer')}: ${endpoint.name}`}
      onClick={onPickPeer}
    >
      {content}
    </button>
  ) : (
    <div className={className}>{content}</div>
  )
}

/** 文件夹内有差异时整行与内容不同的文件同色。 */
function toneOf(item: CompareItem, isSource: boolean, isKeeping: boolean): PaneRow['tone'] {
  if (item.state === 'only') {
    if (isSource) {
      return 'new'
    }
    return isKeeping ? 'only' : 'delete'
  }
  return item.state === 'same' ? 'same' : 'differs'
}

function ComparePane({
  side,
  isSource,
  isKeeping,
  endpoint,
  status,
  isFilterOn,
}: {
  readonly side: CompareSide
  readonly isSource: boolean
  readonly isKeeping: boolean
  readonly endpoint: TransferEndpoint
  readonly status: ComparisonStatus
  readonly isFilterOn: boolean
}): ReactElement {
  const t = useT()
  // 记住进入的文件夹；翻转方向或刷新后按新结果截到仍存在的那一层。
  const [openedPath, setOpenedPath] = useState<readonly string[]>([])
  const comparison = status.kind === 'ready' ? status.comparison : null
  const path = comparison ? existingPath(comparison, side, openedPath) : openedPath
  const items = comparison ? comparisonChildren(comparison, side, path) : []
  const shown = isFilterOn ? items.filter((item) => item.state !== 'same') : items
  const directories = items.filter((item) => item.kind === 'directory').length
  return (
    <FilePane
      label={endpoint.name}
      crumb={[endpoint.rootName, ...path].join(' / ')}
      rows={
        comparison &&
        shown.map((item) => ({
          name: item.name,
          kind: item.kind,
          path: item.path,
          sizeBytes: item.sizeBytes,
          modifiedAt: item.modifiedAt,
          marker: markerOf(item, isSource, isKeeping),
          tone: toneOf(item, isSource, isKeeping),
        }))
      }
      isLoading={status.kind === 'waiting' || status.kind === 'scanning'}
      foot={[
        ...(shown.length === 0
          ? [t(items.length === 0 ? 'compare.emptyFolder' : 'compare.noDifferences')]
          : []),
        ...(items.length > 0
          ? [t('compare.summary', { directories, files: items.length - directories })]
          : []),
      ]}
      onOpen={setOpenedPath}
      onUp={path.length > 0 ? () => setOpenedPath(path.slice(0, -1)) : null}
    />
  )
}

/**
 * 两端比较视图：方向条（左边来源、右边目标，中间按钮交换两端）、摘要行和两端文件列。
 *
 * 摘要行在比较完成后用彩色标签写差异数：~ 内容不同，+ 只在来源有，− 只在目标有；
 * 比较完成前写进度、取消或失败的说明，扫描中可以取消。目标有多出的条目时，摘要行多一个开关：
 * 蓝色“− 保留”，点按后变红色“− 删除”，这些条目随之标红。
 *
 * 放进限高的纵向 flex 容器时铺满剩余高度，两列各自滚动，列头固定在列顶；
 * 列末留出 --ss-pane-end-space 的空白。
 */
export function TransferComparison({
  pc,
  mobile,
  remoteSide,
  direction,
  status,
  isLocked,
  onFlip,
  onPickPeer,
  onRefresh,
  onCancel,
  isKeepingExtras,
  onKeepExtrasChange,
}: TransferComparisonProps): ReactElement {
  const t = useT()
  const [isFilterOn, setIsFilterOn] = useState(false)
  const endpoints = { pc, mobile }
  const [source, target]: readonly [CompareSide, CompareSide] =
    direction === 'windows-to-android' ? ['pc', 'mobile'] : ['mobile', 'pc']
  const comparison = status.kind === 'ready' ? status.comparison : null
  const isScanning = status.kind === 'waiting' || status.kind === 'scanning'
  const card = (side: CompareSide): ReactElement => (
    <EndpointCard
      key={side}
      side={side}
      endpoint={endpoints[side]}
      isSource={side === source}
      isRemote={remoteSide === side}
      isLocked={isLocked}
      onPickPeer={onPickPeer}
    />
  )
  // 按端给定 key：交换左右时两列只换位置，各自所在的文件夹不变。
  const pane = (side: CompareSide): ReactElement => (
    <ComparePane
      key={side}
      side={side}
      isSource={side === source}
      isKeeping={isKeepingExtras}
      endpoint={endpoints[side]}
      status={status}
      isFilterOn={isFilterOn}
    />
  )
  const counts = comparison && [
    {
      key: 'differs',
      sign: '~',
      count: comparison.differingFiles,
      label: t('compare.differs', { count: comparison.differingFiles }),
    },
    {
      key: 'new',
      sign: '+',
      count: comparison.onlyFiles[source],
      label: t('compare.onlySource', { count: comparison.onlyFiles[source] }),
    },
    {
      key: isKeepingExtras ? 'only' : 'delete',
      sign: '−',
      count: comparison.onlyFiles[target],
      label: t(isKeepingExtras ? 'compare.onlyTarget' : 'compare.deleteTarget', {
        count: comparison.onlyFiles[target],
      }),
    },
  ]
  return (
    <div className="ss-transfer">
      <div className="ss-dirbar">
        {card(source)}
        <button
          type="button"
          className="ss-flip ss-pressable"
          disabled={isLocked}
          aria-label={t('transfer.flip')}
          title={t('transfer.flip')}
          onClick={onFlip}
        >
          <SwapOutlined />
        </button>
        {card(target)}
      </div>
      <div className="ss-diffbar">
        {counts === null ? (
          <TransferStatus status={status} />
        ) : counts.every((item) => item.count === 0) ? (
          <span className="ss-count is-same">{t('compare.allSame')}</span>
        ) : (
          counts
            .filter((item) => item.count > 0)
            .map((item) => (
              <span
                key={item.key}
                className={`ss-count is-${item.key}`}
                title={item.label}
                aria-label={item.label}
              >
                <b aria-hidden="true">{item.sign}</b>
                {item.count}
              </span>
            ))
        )}
        <span className="ss-diffbar-space" />
        {isScanning && onCancel && (
          <button type="button" className="ss-chip ss-pressable" onClick={onCancel}>
            <span>{t('common.cancel')}</span>
          </button>
        )}
        {comparison !== null && onKeepExtrasChange && (
          <button
            type="button"
            role="switch"
            className={`ss-chip ss-pressable ss-keep-chip ${isKeepingExtras ? 'is-keep' : 'is-delete'}`}
            aria-checked={isKeepingExtras}
            aria-label={t('compare.keepExtras')}
            title={t('compare.keepExtras')}
            disabled={isLocked}
            onClick={() => onKeepExtrasChange(!isKeepingExtras)}
          >
            <b aria-hidden="true">−</b>
            <span className="ss-keep-chip-label">
              <span hidden={!isKeepingExtras}>{t('plan.stat.keep')}</span>
              <span hidden={isKeepingExtras}>{t('plan.stat.delete')}</span>
            </span>
          </button>
        )}
        {comparison !== null && (
          <button
            type="button"
            className={`ss-chip ss-pressable${isFilterOn ? ' is-on' : ''}`}
            aria-pressed={isFilterOn}
            onClick={() => setIsFilterOn(!isFilterOn)}
          >
            <DiffOutlined />
            <span>{t('compare.filter')}</span>
          </button>
        )}
        <button
          type="button"
          className="ss-chip ss-pressable is-icon"
          aria-label={t('compare.refresh')}
          title={t('compare.refresh')}
          disabled={isLocked || isScanning}
          onClick={onRefresh}
        >
          <ReloadOutlined />
        </button>
      </div>
      <div className="ss-panes">
        {pane(source)}
        {pane(target)}
      </div>
    </div>
  )
}
