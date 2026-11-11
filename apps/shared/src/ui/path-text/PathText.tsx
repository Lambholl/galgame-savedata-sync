import { Fragment, type ReactElement } from 'react'
import { splitPathAtSeparators } from '../../display/path-text.ts'
import './path-text.css'

/** PathText 的参数。 */
export interface PathTextProps {
  /** 要显示的路径，也可以是“设备名 · 路径”这类含路径的文字；完整显示。 */
  readonly path: string
}

/**
 * 显示一段路径：在 `/`、`\` 之后换行，单个片段比容器还宽时才在片段内断开。
 * 字号和颜色继承所在位置。
 */
export function PathText({ path }: PathTextProps): ReactElement {
  const segments = splitPathAtSeparators(path)
  return (
    <span className="ss-path-text">
      {segments.map((segment, index) => (
        <Fragment key={index}>
          {segment}
          {index < segments.length - 1 && <wbr />}
        </Fragment>
      ))}
    </span>
  )
}
