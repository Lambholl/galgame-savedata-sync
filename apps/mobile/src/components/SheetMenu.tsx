import type { ReactNode } from 'react'
import { Button } from 'antd'
import { RightOutlined } from '@ant-design/icons'
import { Sheet } from './Sheet'

/** 底部弹层菜单里的一项操作。 */
export interface SheetMenuItem {
  readonly key: string
  readonly label: string
  readonly icon: ReactNode
  readonly isDanger?: boolean
  readonly isDisabled?: boolean
  /** 点按这一项后触发，调用前弹层已请求关闭。 */
  readonly onSelect: () => void
}

/** 底部弹层形式的操作菜单，包含可选说明行、顶部整行主操作按钮与下方两列次级操作卡片。 */
export function SheetMenu({
  isOpen,
  title,
  caption = null,
  primary = null,
  actions,
  onClose,
}: {
  readonly isOpen: boolean
  readonly title: string
  /** 显示在标题下方的状态或上下文说明；不传或为 null 时不显示。 */
  readonly caption?: string | null
  /** 顶部整行主操作按钮；不传或为 null 时不显示。 */
  readonly primary?: SheetMenuItem | null
  /** 下方两列排布的次级操作卡片；只有一项时占满整行，为空时不显示。 */
  readonly actions: readonly SheetMenuItem[]
  readonly onClose: () => void
}): React.JSX.Element {
  return (
    <Sheet isOpen={isOpen} title={title} onClose={onClose}>
      <div className="ss-game-actions">
        {caption ? <p className="ss-game-caption">{caption}</p> : null}
        {primary ? (
          <Button
            type="primary"
            block
            className="ss-game-primary"
            disabled={Boolean(primary.isDisabled)}
            onClick={() => {
              onClose()
              primary.onSelect()
            }}
          >
            <span className="ss-game-primary-icon" aria-hidden="true">
              {primary.icon}
            </span>
            <strong>{primary.label}</strong>
            <RightOutlined />
          </Button>
        ) : null}
        {actions.length ? (
          <div className="ss-game-action-grid">
            {actions.map((item) => (
              <Button
                key={item.key}
                variant="filled"
                danger={Boolean(item.isDanger)}
                className={`ss-game-action${item.isDanger ? ' is-danger' : ''}`}
                disabled={Boolean(item.isDisabled)}
                onClick={() => {
                  onClose()
                  item.onSelect()
                }}
              >
                {item.icon}
                <b>{item.label}</b>
              </Button>
            ))}
          </div>
        ) : null}
      </div>
    </Sheet>
  )
}
