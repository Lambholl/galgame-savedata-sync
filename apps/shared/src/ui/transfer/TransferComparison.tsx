import { useState, type ReactElement } from 'react'
import {
  ArrowRightOutlined,
  DesktopOutlined,
  DownOutlined,
  FilterOutlined,
  LoadingOutlined,
  MobileOutlined,
  ReloadOutlined,
} from '@ant-design/icons'
import type { TransferDirection } from '../../protocol/contracts.ts'
import { formatBytes, formatShortDateTime } from '../../i18n/format.ts'
import { comparisonChildren } from '../../sync/snapshot-compare.ts'
import type { CompareItem, CompareSide, SnapshotComparison } from '../../sync/snapshot-compare.ts'
import { FileIcon } from '../files/FileIcon.tsx'
import type { FileIconMarker } from '../files/FileIcon.tsx'
import { useLocale, useT } from '../i18n/i18n-context.ts'
import './transfer-comparison.css'

/** 方向条上一端的显示信息。 */
export interface TransferEndpoint {
  /** 主标题：本机写“本机”，对端写设备名。 */
  readonly name: string
  /** 副标题：本机写本机设备名；对端不需要时传空字符串，由连接状态代替。 */
  readonly caption: string
  /** 对端是否在线，显示状态点；本机传 null。 */
  readonly isOnline: boolean | null
  /** 该端存档目录的显示名，作为该列路径的起点。 */
  readonly rootName: string
}

/** 两端比较的进度：比较中、已完成，或无法比较（附原因）。 */
export type ComparisonStatus =
  | { readonly kind: 'comparing' }
  | { readonly kind: 'ready'; readonly comparison: SnapshotComparison }
  | { readonly kind: 'unavailable'; readonly message: string }

/** compact：手机双列，每行两行文字；wide：电脑双列表格（名称/大小/修改时间）。 */
export type TransferLayout = 'compact' | 'wide'

/** TransferComparison 的参数。 */
export interface TransferComparisonProps {
  /** 左侧电脑一端。 */
  readonly pc: TransferEndpoint
  /** 右侧手机一端。 */
  readonly phone: TransferEndpoint
  /** 哪一端是对端设备；点它的名称会调用 onPickPeer。 */
  readonly remoteSide: CompareSide
  /** 当前传输方向，决定来源/目标标签和箭头朝向。 */
  readonly direction: TransferDirection
  /** 比较进度与结果。 */
  readonly status: ComparisonStatus
  /** 排版：手机 compact，电脑 wide。 */
  readonly layout: TransferLayout
  /** 为 true 时禁用翻转、切换设备和刷新（例如正在传输）。 */
  readonly isLocked: boolean
  /** 点中间箭头：翻转传输方向。 */
  readonly onFlip: () => void
  /** 点对端名称：由各端弹出设备选择。 */
  readonly onPickPeer: () => void
  /** 重新扫描两端。 */
  readonly onRefresh: () => void
}

function markerOf(item: CompareItem): FileIconMarker {
  return item.state === 'only' ? 'only' : item.state === 'same' ? 'none' : 'warn'
}

function EndpointCard({
  side,
  endpoint,
  isSource,
  isRemote,
  layout,
  isLocked,
  onPickPeer,
}: {
  readonly side: CompareSide
  readonly endpoint: TransferEndpoint
  readonly isSource: boolean
  readonly isRemote: boolean
  readonly layout: TransferLayout
  readonly isLocked: boolean
  readonly onPickPeer: () => void
}): ReactElement {
  const t = useT()
  const content = (
    <>
      <span className="ss-end-name">
        {layout === 'wide' && (side === 'pc' ? <DesktopOutlined /> : <MobileOutlined />)}
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
      className={className}
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

function ComparePane({
  side,
  endpoint,
  status,
  layout,
  isFilterOn,
}: {
  readonly side: CompareSide
  readonly endpoint: TransferEndpoint
  readonly status: ComparisonStatus
  readonly layout: TransferLayout
  readonly isFilterOn: boolean
}): ReactElement {
  const t = useT()
  const locale = useLocale()
  const [path, setPath] = useState<readonly string[]>([])
  const now = Date.now()
  const items = status.kind === 'ready' ? comparisonChildren(status.comparison, side, path) : []
  const shown = isFilterOn ? items.filter((item) => item.state !== 'same') : items
  const directories = items.filter((item) => item.kind === 'directory').length
  const time = (value: number | null): string =>
    value === null ? '—' : formatShortDateTime(value, locale, now)
  const size = (item: CompareItem): string =>
    item.kind === 'directory' ? '—' : item.sizeBytes === null ? '—' : formatBytes(item.sizeBytes)
  const flag = (item: CompareItem): string | null =>
    item.kind === 'directory' && item.differingCount > 0
      ? t('compare.containsDifferences', { count: item.differingCount })
      : null
  const crumb = [endpoint.rootName, ...path].join(' / ')
  return (
    <section className={`ss-pane is-${layout}`} aria-label={endpoint.name}>
      {layout === 'wide' ? (
        <div className="ss-pane-head ss-pane-columns">
          <span className="ss-pane-crumb" title={crumb}>
            {crumb}
          </span>
          <span>{t('compare.size')}</span>
          <span>{t('compare.modified')}</span>
        </div>
      ) : (
        <div className="ss-pane-head" title={crumb}>
          <span className="ss-pane-crumb">{crumb}</span>
        </div>
      )}
      {status.kind !== 'ready' ? (
        <p className="ss-pane-placeholder">
          {status.kind === 'comparing' ? <LoadingOutlined /> : status.message}
        </p>
      ) : (
        <>
          {path.length > 0 && (
            <button
              type="button"
              className="ss-row is-up"
              aria-label={t('compare.up')}
              onClick={() => setPath(path.slice(0, -1))}
            >
              <FileIcon kind="directory" marker="none" />
              <span className="ss-row-name">..</span>
            </button>
          )}
          {shown.map((item) => {
            const body =
              layout === 'wide' ? (
                <>
                  <FileIcon kind={item.kind} marker={markerOf(item)} />
                  <span className="ss-row-name">
                    {item.name}
                    {flag(item) && <small className="ss-row-flag">{flag(item)}</small>}
                  </span>
                  <span className="ss-row-cell">{size(item)}</span>
                  <span className="ss-row-cell">{time(item.modifiedAt)}</span>
                </>
              ) : (
                <>
                  <FileIcon kind={item.kind} marker={markerOf(item)} />
                  <span className="ss-row-body">
                    <span className="ss-row-name">{item.name}</span>
                    <span className="ss-row-meta">
                      {flag(item) ? (
                        <span className="ss-row-flag">{flag(item)}</span>
                      ) : (
                        <span>{time(item.modifiedAt)}</span>
                      )}
                      {item.kind !== 'directory' && <span>{size(item)}</span>}
                    </span>
                  </span>
                </>
              )
            const className = `ss-row is-${item.state}`
            return item.kind === 'directory' ? (
              <button
                type="button"
                key={item.name}
                className={className}
                onClick={() => setPath(item.path)}
              >
                {body}
              </button>
            ) : (
              <div key={item.name} className={className}>
                {body}
              </div>
            )
          })}
          {shown.length === 0 && (
            <p className="ss-pane-foot">
              {t(items.length === 0 ? 'compare.emptyFolder' : 'compare.noDifferences')}
            </p>
          )}
          {items.length > 0 && (
            <p className="ss-pane-foot">
              {t('compare.summary', { directories, files: items.length - directories })}
            </p>
          )}
        </>
      )}
    </section>
  )
}

/**
 * 传输存档页主体：方向条（左电脑、右手机，位置固定）、差异摘要与两端文件列。
 * 两端自动比较后着色：琥珀色为内容不同，蓝色为只在这一端有；文件夹始终排在文件前。
 */
export function TransferComparison({
  pc,
  phone,
  remoteSide,
  direction,
  status,
  layout,
  isLocked,
  onFlip,
  onPickPeer,
  onRefresh,
}: TransferComparisonProps): ReactElement {
  const t = useT()
  const [isFilterOn, setIsFilterOn] = useState(false)
  const isPcSource = direction === 'windows-to-android'
  const comparison = status.kind === 'ready' ? status.comparison : null
  return (
    <div className={`ss-transfer is-${layout}`}>
      <div className="ss-dirbar">
        <EndpointCard
          side="pc"
          endpoint={pc}
          isSource={isPcSource}
          isRemote={remoteSide === 'pc'}
          layout={layout}
          isLocked={isLocked}
          onPickPeer={onPickPeer}
        />
        <button
          type="button"
          className={`ss-flip${isPcSource ? '' : ' is-reversed'}`}
          disabled={isLocked}
          aria-label={t('transfer.flip')}
          onClick={onFlip}
        >
          <ArrowRightOutlined />
        </button>
        <EndpointCard
          side="phone"
          endpoint={phone}
          isSource={!isPcSource}
          isRemote={remoteSide === 'phone'}
          layout={layout}
          isLocked={isLocked}
          onPickPeer={onPickPeer}
        />
      </div>
      <div className="ss-diffbar">
        {comparison === null ? (
          <span className="ss-diffbar-status">
            {status.kind === 'comparing' ? t('transfer.comparing') : null}
          </span>
        ) : comparison.differingFiles + comparison.onlyFiles === 0 ? (
          <span className="ss-pill is-ok">{t('compare.allSame')}</span>
        ) : (
          <>
            {comparison.differingFiles > 0 && (
              <span className="ss-pill is-warn">
                {t('compare.differs', { count: comparison.differingFiles })}
              </span>
            )}
            {comparison.onlyFiles > 0 && (
              <span className="ss-pill is-only">
                {t('compare.only', { count: comparison.onlyFiles })}
              </span>
            )}
          </>
        )}
        <span className="ss-diffbar-space" />
        <button
          type="button"
          className={`ss-chip${isFilterOn ? ' is-on' : ''}`}
          aria-pressed={isFilterOn}
          disabled={comparison === null}
          onClick={() => setIsFilterOn(!isFilterOn)}
        >
          <FilterOutlined />
          {t('compare.filter')}
        </button>
        <button
          type="button"
          className="ss-chip is-icon"
          aria-label={t('compare.refresh')}
          title={t('compare.refresh')}
          disabled={isLocked || status.kind === 'comparing'}
          onClick={onRefresh}
        >
          <ReloadOutlined />
        </button>
      </div>
      <div className="ss-panes">
        <ComparePane
          side="pc"
          endpoint={pc}
          status={status}
          layout={layout}
          isFilterOn={isFilterOn}
        />
        <ComparePane
          side="phone"
          endpoint={phone}
          status={status}
          layout={layout}
          isFilterOn={isFilterOn}
        />
      </div>
    </div>
  )
}
