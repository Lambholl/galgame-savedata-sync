import { Fragment, type ReactElement } from 'react'
import { splitPathAtSeparators } from '../../display/path-text.ts'
import './path-text.css'

/** PathText 的参数。字号与颜色继承所在位置。 */
export interface PathTextProps {
  /** 要显示的目录或文件路径，也可以是“设备名 · 路径”这类含路径的说明；原样显示，不做截断。 */
  readonly path: string
}

/**
 * 显示一段路径：只在 `/`、`\` 之后换行，避免浏览器在“内部存储”这类中文名字中间断开。
 * 单个片段比容器还宽时才在片段内断开。
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
