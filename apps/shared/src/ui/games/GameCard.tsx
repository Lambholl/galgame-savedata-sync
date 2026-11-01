import type { ReactElement } from 'react'
import { Button } from 'antd'
import { useT } from '../i18n/i18n-context.ts'
import './game-card.css'

/** 双端游戏卡片的展示参数。 */
export interface GameCardProps {
  /** 完整游戏名。接入图片前，封面内显示游戏名；封面下方只显示一行，超出省略。 */
  readonly gameName: string
  /** 已关联设备数，零表示未关联。 */
  readonly linkCount: number
  /** 占位封面的配色序号。 */
  readonly coverIndex: number
  /** 打开游戏操作面板；长按、右键由平台包装组件处理。 */
  readonly onOpen: () => void
}

/** 竖向封面、独立名称和关联摘要；两端复用同一份渲染。 */
export function GameCard({ gameName, linkCount, coverIndex, onOpen }: GameCardProps): ReactElement {
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
      <span className={`ss-game-cover is-${coverIndex % 4}`} aria-hidden="true">
        <strong>{gameName}</strong>
      </span>
      <span className="ss-game-card-name">{gameName}</span>
      <span className="ss-game-card-subtitle" title={subtitle}>
        {subtitle}
      </span>
    </Button>
  )
}
