import { Button } from 'antd-mobile'
import { Sheet } from './Sheet'
import { ChoiceField } from './ChoiceField'
import type { ChoiceOption } from './ChoiceField'

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
  return (
    <Sheet isOpen={isOpen} title="从设备导入游戏" layer={1100} isBusy={isBusy} onClose={onCancel}>
      <div className="page-stack">
        <ChoiceField
          label="选择游戏"
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
          导入
        </Button>
        <Button block disabled={isBusy} onClick={onCancel}>
          取消
        </Button>
      </div>
    </Sheet>
  )
}
