import { Button, Modal } from 'antd'
import { useT } from '@savedata-sync/shared/ui'

/** 上次写入被中断的一次性提示；没有备份时只说明情况，不提示恢复。 */
export function InterruptedWriteDialog({
  gameName,
  hasBackup,
  onViewBackup,
  onClose,
}: {
  /** 要提示的游戏名；null 时不显示。 */
  readonly gameName: string | null
  readonly hasBackup: boolean
  readonly onViewBackup: () => void
  readonly onClose: () => void
}): React.JSX.Element {
  const t = useT()
  const name = gameName ?? ''
  return (
    <Modal
      open={gameName !== null}
      title={t('write.interruptedTitle')}
      closable={false}
      onCancel={onClose}
      footer={
        <>
          {hasBackup ? <Button onClick={onViewBackup}>{t('task.viewBackup')}</Button> : null}
          <Button type="primary" onClick={onClose}>
            {t('common.gotIt')}
          </Button>
        </>
      }
    >
      <p>
        {hasBackup
          ? t('write.interruptedWithBackup', { name })
          : t('write.interruptedNoBackup', { name })}
      </p>
    </Modal>
  )
}
