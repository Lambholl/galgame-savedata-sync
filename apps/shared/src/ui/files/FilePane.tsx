import type { ReactElement } from 'react'
import { LoadingOutlined } from '@ant-design/icons'
import { formatBytes, formatShortDateTime } from '../../i18n/format.ts'
import type { FileKind } from '../../sync/snapshot-compare.ts'
import { FileIcon } from './FileIcon.tsx'
import type { FileIconMarker } from './FileIcon.tsx'
import { useT } from '../i18n/i18n-context.ts'
import './file-pane.css'

/** 文件列里的一行；文件夹可以点进去。 */
export interface PaneRow {
  readonly name: string
  readonly kind: FileKind
  /** 从列根目录起的完整路径，点文件夹时传给 onOpen。 */
  readonly path: readonly string[]
  readonly sizeBytes: number | null
  readonly modifiedAt: number | null
  readonly marker: FileIconMarker
  /** 行的差异底色：same 无底色，differs 覆盖，only 只在目标，new 新建，delete 将从目标删除。 */
  readonly tone: 'same' | 'differs' | 'only' | 'new' | 'delete'
}

/**
 * 一列文件：列头写路径，文件夹排在文件前，点文件夹进入、“..”返回上一层。
 * 窄列名称最多两行、下方小字写时间与大小，宽列为名称 / 大小 / 修改时间三列。
 * 传输页两端和备份文件共用，行的样式完全相同。
 */
export function FilePane({
  label,
  crumb,
  rows,
  isLoading,
  foot,
  onOpen,
  onUp,
}: {
  /** 列的读屏名称。 */
  readonly label: string
  /** 列头显示的路径。 */
  readonly crumb: string
  /** 当前文件夹里的行；还没有结果时为 null。 */
  readonly rows: readonly PaneRow[] | null
  /** 没有结果时是否显示加载中。 */
  readonly isLoading: boolean
  /** 列末的说明，每项一行。 */
  readonly foot: readonly string[]
  readonly onOpen: (path: readonly string[]) => void
  /** 返回上一层；已在根目录时为 null。 */
  readonly onUp: (() => void) | null
}): ReactElement {
  const t = useT()
  const time = (value: number | null): string => (value === null ? '—' : formatShortDateTime(value))
  const size = (row: PaneRow): string =>
    row.kind === 'directory' || row.sizeBytes === null ? '—' : formatBytes(row.sizeBytes)
  return (
    <section className="ss-pane" aria-label={label}>
      <div className="ss-pane-head">
        <span className="ss-pane-crumb" title={crumb}>
          {crumb}
        </span>
        <span className="ss-pane-label">{t('compare.size')}</span>
        <span className="ss-pane-label">{t('compare.modified')}</span>
      </div>
      {rows === null ? (
        isLoading && (
          <div className="ss-pane-placeholder" aria-busy="true">
            <LoadingOutlined />
          </div>
        )
      ) : (
        <>
          {onUp && (
            <button
              type="button"
              className="ss-row is-up ss-pressable"
              aria-label={t('compare.up')}
              onClick={onUp}
            >
              <FileIcon kind="directory" marker="none" />
              <span className="ss-row-name">..</span>
            </button>
          )}
          {rows.map((row) => {
            // 同一份内容：窄列显示名称下方的小字，宽列显示右侧两格，由样式按列宽选择。
            const body = (
              <>
                <FileIcon kind={row.kind} marker={row.marker} />
                <span className="ss-row-body">
                  <span className="ss-row-name" title={row.name}>
                    {row.name}
                  </span>
                  <span className="ss-row-meta">
                    {row.modifiedAt !== null && <span>{time(row.modifiedAt)}</span>}
                    {row.kind !== 'directory' && <span>{size(row)}</span>}
                  </span>
                </span>
                <span className="ss-row-cell">{size(row)}</span>
                <span className="ss-row-cell">{time(row.modifiedAt)}</span>
              </>
            )
            const className = `ss-row is-${row.tone}`
            return row.kind === 'directory' ? (
              <button
                type="button"
                key={row.name}
                className={`${className} ss-pressable`}
                onClick={() => onOpen(row.path)}
              >
                {body}
              </button>
            ) : (
              <div key={row.name} className={className}>
                {body}
              </div>
            )
          })}
          {foot.map((text) => (
            <p className="ss-pane-foot" key={text}>
              {text}
            </p>
          ))}
        </>
      )}
    </section>
  )
}
