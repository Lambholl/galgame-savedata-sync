import type { ReactElement } from 'react'
import { Button } from 'antd'
import { useT } from '../i18n/i18n-context.ts'
import { PosterCover } from '../poster/PosterCover.tsx'
import './game-card.css'

/** GameCard 的参数。 */
export interface GameCardProps {
  /** 完整游戏名，占位封面内显示全名；封面下方只显示一行，超出部分省略。 */
  readonly gameName: string
  /** 已关联设备数，零表示未关联。 */
  readonly linkCount: number
  /** 占位封面的配色序号。 */
  readonly coverIndex: number
  /** 封面图地址；为 null 或加载失败时显示占位封面。 */
  readonly posterUrl: string | null
  /** 点按卡片。 */
  readonly onOpen: () => void
}

/** 游戏卡片：竖向封面、名称和关联摘要。 */
export function GameCard({
  gameName,
  linkCount,
  coverIndex,
  posterUrl,
  onOpen,
}: GameCardProps): ReactElement {
  const t = useT()
  const subtitle = linkCount ? t('game.cardLinks', { count: linkCount }) : t('game.cardUnlinked')
  return (
    <Button
      type="text"
      block
      className="ss-game-card"
      title={gameName}
      aria-label={`${gameName} ${subtitle}`}
      onClick={onOpen}
      onDragStart={(event) => event.preventDefault()}
    >
      <PosterCover
        imageUrl={posterUrl}
        placeholderText={gameName}
        coverIndex={coverIndex}
        size="card"
      />
      <span className="ss-game-card-name">{gameName}</span>
      <span className="ss-game-card-subtitle" title={subtitle}>
        {subtitle}
      </span>
    </Button>
  )
}
