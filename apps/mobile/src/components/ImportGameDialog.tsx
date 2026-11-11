import { Button } from 'antd-mobile'
import { useT } from '@savedata-sync/shared/ui'
import { Sheet } from './Sheet'
import { ChoiceField } from './ChoiceField'
import type { ChoiceOption } from './ChoiceField'

/** 从对端设备导入游戏的弹层。 */
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
  readonly options: readonly ChoiceOption[]
  readonly onImportKeyChange: (value: string) => void
  readonly onCancel: () => void
  readonly onImport: () => void
}): React.JSX.Element {
  const t = useT()
  return (
    <Sheet
      isOpen={isOpen}
      title={t('game.importTitle')}
      layer={1100}
      isBusy={isBusy}
      onClose={onCancel}
    >
      <div className="page-stack">
        <ChoiceField
          label={t('game.pickGame')}
          value={importKey}
          options={options}
          isDisabled={isBusy}
          onChange={onImportKeyChange}
        />
        <Button
          block
          color="primary"
          loading={isBusy}
          disabled={isBusy || !importKey}
          onClick={onImport}
        >
          {t('game.import')}
        </Button>
        <Button block disabled={isBusy} onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </Sheet>
  )
}
