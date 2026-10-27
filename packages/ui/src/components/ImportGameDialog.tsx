import { Modal, Select } from 'antd'

export interface ImportGameOption {
  readonly value: string
  readonly label: string
}

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
  return (
    <Modal
      title="从设备导入游戏"
      open={isOpen}
      okText="导入"
      okButtonProps={{ disabled: !importKey }}
      confirmLoading={isBusy}
      onCancel={onCancel}
      onOk={onImport}
    >
      <Select
        className="library-full"
        aria-label="导入游戏"
        value={importKey || null}
        placeholder="选择游戏"
        options={[...options]}
        onChange={onImportKeyChange}
      />
    </Modal>
  )
}
