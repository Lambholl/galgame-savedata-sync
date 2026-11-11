import { Modal, Select } from 'antd'
import { useT } from '@savedata-sync/shared/ui'

/** 可导入游戏下拉框中的一个选项。 */
export interface ImportGameOption {
  readonly value: string
  readonly label: string
}

/** 从对端设备导入游戏的弹窗。 */
export function ImportGameDialog({
  isOpen,
  importKey,
  isBusy,
  options,
  onImportKeyChange,
  onCancel,
  onImport,
}: {
  readonly isOpen: boolean
  readonly importKey: string
  readonly isBusy: boolean
  readonly options: readonly ImportGameOption[]
  readonly onImportKeyChange: (value: string) => void
  readonly onCancel: () => void
  readonly onImport: () => void
}): React.JSX.Element {
  const t = useT()
  return (
    <Modal
      title={t('game.importTitle')}
      open={isOpen}
      okText={t('game.import')}
      cancelText={t('common.cancel')}
      okButtonProps={{ disabled: !importKey }}
      confirmLoading={isBusy}
      onCancel={onCancel}
      onOk={onImport}
    >
      <Select
        className="library-full"
        aria-label={t('game.import')}
        value={importKey || null}
        placeholder={t('game.pickGame')}
        options={[...options]}
        onChange={onImportKeyChange}
      />
    </Modal>
  )
}
