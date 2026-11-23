import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import type { PosterOrigin } from '../../poster/poster-contracts.ts'
import { useT } from '../i18n/i18n-context.ts'
import { PosterCover } from './PosterCover.tsx'
import { POSTER_SOURCE_NAMES } from './poster-labels.ts'
import '../devices/devices.css'

/** PosterRow 的参数。 */
export interface PosterRowProps {
  /** 游戏已设置封面。 */
  readonly hasPoster: boolean
  /** 封面的出处；没有封面或配置里没有记录时为 null，说明行只写尺寸。 */
  readonly posterSource: PosterOrigin | null
  /** 封面图地址；没有封面、还没读出或读取失败时为 null，缩略图显示占位配色。 */
  readonly posterUrl: string | null
  /** 占位封面的配色序号，和游戏卡片一致。 */
  readonly coverIndex: number
  /** 操作按钮，排在文字右侧；行宽放不下时整组换到文字下方。为 null 时文字独占这一行。 */
  readonly actions: ReactNode
  /** 菜单按钮，固定在行尾、垂直居中，不随操作按钮换行；为 null 时不显示。 */
  readonly menu: ReactNode
}

/** 封面图的原图尺寸；url 用来丢弃换图前读到的尺寸。 */
interface ImageSize {
  readonly url: string
  readonly width: number
  readonly height: number
}

/** 游戏设置里的封面一行：缩略图，是否已设置封面和封面的出处、尺寸，以及操作按钮。 */
export function PosterRow({
  hasPoster,
  posterSource,
  posterUrl,
  coverIndex,
  actions,
  menu,
}: PosterRowProps): ReactElement {
  const t = useT()
  const [imageSize, setImageSize] = useState<ImageSize | null>(null)
  const [isStacked, setIsStacked] = useState(false)
  const mainRef = useRef<HTMLSpanElement>(null)
  const bodyRef = useRef<HTMLSpanElement>(null)
  const actionsRef = useRef<HTMLSpanElement>(null)
  const size = imageSize && imageSize.url === posterUrl ? imageSize : null
  let caption: string
  if (hasPoster) {
    const source =
      posterSource === null
        ? null
        : posterSource === 'local'
          ? t('poster.local')
          : POSTER_SOURCE_NAMES[posterSource]
    caption = [source, size ? `${size.width}×${size.height}` : null]
      .filter((part) => part !== null)
      .join(' · ')
  } else {
    caption = t('poster.noneHint')
  }
  // 两行文字和按钮组并排放不下时，按钮组换到下面，说明行并到标题后面。flex 换行后 CSS 无从得知，
  // 所以按各部分的原本宽度自己算：标题和说明行都按内容宽度排版，两种摆法下量到的宽度相同，切换不会来回抖动。
  // caption 变化时说明行可能新出现或消失，重新挂观察。
  useLayoutEffect(() => {
    const main = mainRef.current
    const body = bodyRef.current
    const actionList = actionsRef.current
    if (!main || !body || !actionList) {
      return
    }
    const measure = (): void => {
      const textWidth = Math.max(
        ...Array.from(body.children, (child) => child.getBoundingClientRect().width),
      )
      const gap = parseFloat(getComputedStyle(main).columnGap) || 0
      const actionWidth = actionList.getBoundingClientRect().width
      setIsStacked(Math.ceil(textWidth + gap + actionWidth) > main.clientWidth)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(main)
    observer.observe(actionList)
    for (const child of Array.from(body.children)) {
      observer.observe(child)
    }
    return () => observer.disconnect()
  }, [caption])
  return (
    <div className="ss-list">
      <div className="ss-list-row">
        <PosterCover
          imageUrl={posterUrl}
          placeholderText=""
          coverIndex={coverIndex}
          size="thumb"
          onImageLoad={(width, height) => {
            if (posterUrl !== null) {
              setImageSize({ url: posterUrl, width, height })
            }
          }}
        />
        <span ref={mainRef} className={`ss-poster-row-main${isStacked ? ' is-stacked' : ''}`}>
          <span ref={bodyRef} className="ss-list-body">
            <b>{hasPoster ? t('poster.has') : t('poster.none')}</b>
            {caption === '' ? null : <small>{caption}</small>}
          </span>
          {actions === null ? null : (
            <span ref={actionsRef} className="ss-poster-row-actions">
              {actions}
            </span>
          )}
        </span>
        {menu}
      </div>
    </div>
  )
}
