import { useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import './poster.css'

/** PosterCover 的参数。 */
export interface PosterCoverProps {
  /** 封面图地址；为 null 或图片加载失败时显示占位封面。 */
  readonly imageUrl: string | null
  /** 占位封面上显示的文字；size 为 thumb 时不显示。 */
  readonly placeholderText: string
  /** 占位封面的配色序号。 */
  readonly coverIndex: number
  /** card：宽度铺满父元素；thumb：列表行里的小缩略图。 */
  readonly size: 'card' | 'thumb'
  /** 叠在封面上面的内容，如角标和加载指示。 */
  readonly children?: ReactNode
  /** 图片加载完成时以原图的宽高（像素）调用；占位封面和加载失败时不调用。 */
  readonly onImageLoad?: (width: number, height: number) => void
}

/** 3:4 的封面：有图时铺满并居中裁切，没有图时显示占位配色和文字。 */
export function PosterCover({
  imageUrl,
  placeholderText,
  coverIndex,
  size,
  children,
  onImageLoad,
}: PosterCoverProps): ReactElement {
  // 记下加载失败的地址而不是布尔值，换了地址自然重新尝试。
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null)
  const shownUrl = imageUrl !== null && imageUrl !== brokenUrl ? imageUrl : null
  const className = [
    'ss-game-cover',
    `is-${coverIndex % 4}`,
    shownUrl ? 'has-poster' : '',
    size === 'thumb' ? 'ss-poster-thumb' : '',
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <span className={className} aria-hidden="true">
      {shownUrl ? (
        <img
          src={shownUrl}
          alt=""
          draggable={false}
          onLoad={(event) =>
            onImageLoad?.(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)
          }
          onError={() => setBrokenUrl(shownUrl)}
        />
      ) : (
        <strong>{placeholderText}</strong>
      )}
      {children}
    </span>
  )
}
