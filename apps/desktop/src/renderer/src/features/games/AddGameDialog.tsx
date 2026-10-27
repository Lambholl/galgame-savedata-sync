import { Button, Input, Modal } from 'antd'
import { FolderOpenOutlined, RightOutlined } from '@ant-design/icons'
import type { DirectoryReference } from '@savedata-sync/shared'

/** 选择目录后才保存游戏；取消弹窗保留现有游戏列表。 */
export function AddGameDialog({
  isOpen,
  directory,
  gameName,
  isBusy,
  error,
  onChooseDirectory,
  onGameNameChange,
  onCancel,
  onConfirm,
}: {
  readonly isOpen: boolean
  readonly directory: DirectoryReference | null
  readonly gameName: string
  readonly isBusy: boolean
  readonly error: string
  readonly onChooseDirectory: () => void
  readonly onGameNameChange: (value: string) => void
  readonly onCancel: () => void
  readonly onConfirm: () => void
}): React.JSX.Element {
  return (
    <Modal
      title="添加游戏"
      centered
      open={isOpen}
      okText="确定"
      cancelText="取消"
      confirmLoading={isBusy}
      okButtonProps={{ disabled: isBusy || !directory || !gameName.trim() }}
      cancelButtonProps={{ disabled: isBusy }}
      closable={!isBusy}
      keyboard={!isBusy}
      mask={{ closable: !isBusy }}
      onCancel={onCancel}
      onOk={onConfirm}
    >
      <Button
        block
        className="library-add-game-directory"
        disabled={isBusy}
        onClick={onChooseDirectory}
      >
        <FolderOpenOutlined aria-hidden="true" />
        <span>
          <strong>选择存档目录</strong>
          <small>{directory?.displayPath ?? directory?.displayName ?? '未选择目录'}</small>
        </span>
        <RightOutlined aria-hidden="true" />
      </Button>
      {directory && (
        <label className="library-field library-add-game-name">
          游戏名称
          <Input
            aria-label="游戏名称"
            value={gameName}
            maxLength={128}
            disabled={isBusy}
            onChange={(event) => onGameNameChange(event.target.value)}
            placeholder="输入游戏名称"
          />
        </label>
      )}
      {error && <p role="alert">{error}</p>}
    </Modal>
  )
}
