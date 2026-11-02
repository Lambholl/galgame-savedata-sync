import { Button } from 'antd-mobile'
import { useT } from '@savedata-sync/shared/ui'
import { Sheet } from './Sheet'

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
    <Sheet
      isOpen={gameName !== null}
      title={t('write.interruptedTitle')}
      layer={1200}
      isBusy={false}
      onClose={onClose}
    >
      <p className="confirmation-text">
        {hasBackup
          ? t('write.interruptedWithBackup', { name })
          : t('write.interruptedNoBackup', { name })}
      </p>
      <div className="action-row equal">
        {hasBackup ? <Button onClick={onViewBackup}>{t('task.viewBackup')}</Button> : null}
        <Button color="primary" onClick={onClose}>
          {t('common.gotIt')}
        </Button>
      </div>
    </Sheet>
  )
}
