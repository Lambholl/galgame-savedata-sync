import { Button, Modal } from 'antd'
import type { DataResetItem } from '@savedata-sync/shared'
import { useT } from '@savedata-sync/shared/ui'

/** 启动时数据读不懂、已改用默认值的一次性提示，列出被重置的数据项。 */
export function DataResetDialog({
  items,
  onOpenFolder,
  onClose,
}: {
  /** 被重置的数据项；为空时不显示。 */
  readonly items: readonly DataResetItem[]
  readonly onOpenFolder: () => void
  readonly onClose: () => void
}): React.JSX.Element {
  const t = useT()
  return (
    <Modal
      open={items.length > 0}
      title={t('dataReset.title')}
      closable={false}
      onCancel={onClose}
      footer={
        <>
          <Button onClick={onOpenFolder}>{t('dataReset.openFolder')}</Button>
          <Button type="primary" onClick={onClose}>
            {t('common.gotIt')}
          </Button>
        </>
      }
    >
      <p>{t('dataReset.intro')}</p>
      <ul>
        {items.map((item) => (
          <li key={item}>{t(`dataReset.item.${item}`)}</li>
        ))}
      </ul>
      <p>{t('dataReset.keptHint')}</p>
    </Modal>
  )
}
