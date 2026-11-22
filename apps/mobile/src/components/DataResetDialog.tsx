import { Button } from 'antd-mobile'
import type { DataResetItem } from '@savedata-sync/shared'
import { useT } from '@savedata-sync/shared/ui'
import { Sheet } from './Sheet'

/** 启动时数据读不懂、已改用默认值的一次性提示，列出被重置的数据项。 */
export function DataResetDialog({
  items,
  onClose,
}: {
  /** 被重置的数据项；为空时不显示。 */
  readonly items: readonly DataResetItem[]
  readonly onClose: () => void
}): React.JSX.Element {
  const t = useT()
  return (
    <Sheet
      isOpen={items.length > 0}
      title={t('dataReset.title')}
      layer={1200}
      isBusy={false}
      onClose={onClose}
    >
      <p className="confirmation-text">{t('dataReset.intro')}</p>
      <ul className="confirmation-text">
        {items.map((item) => (
          <li key={item}>{t(`dataReset.item.${item}`)}</li>
        ))}
      </ul>
      <div className="action-row equal">
        <Button color="primary" onClick={onClose}>
          {t('common.gotIt')}
        </Button>
      </div>
    </Sheet>
  )
}
