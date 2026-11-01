import { Button, Input, Modal } from 'antd'
import { FolderOpenOutlined, RightOutlined } from '@ant-design/icons'
import type { DirectoryReference, ShownError } from '@savedata-sync/shared'
import { ErrorText, PathText, useT } from '@savedata-sync/shared/ui'

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
  readonly error: ShownError | null
  readonly onChooseDirectory: () => void
  readonly onGameNameChange: (value: string) => void
  readonly onCancel: () => void
  readonly onConfirm: () => void
}): React.JSX.Element {
  const t = useT()
  return (
    <Modal
      title={t('game.add')}
      centered
      open={isOpen}
      okText={t('common.confirm')}
      cancelText={t('common.cancel')}
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
          <strong>{t('game.chooseFolder')}</strong>
          <small>
            {directory ? (
              <PathText path={directory.displayPath ?? directory.displayName} />
            ) : (
              t('game.noFolder')
            )}
          </small>
        </span>
        <RightOutlined aria-hidden="true" />
      </Button>
      {directory && (
        <label className="library-field library-add-game-name">
          {t('game.name')}
          <Input
            aria-label={t('game.name')}
            value={gameName}
            maxLength={128}
            disabled={isBusy}
            onChange={(event) => onGameNameChange(event.target.value)}
            placeholder={t('game.namePlaceholder')}
          />
        </label>
      )}
      {error && (
        <p role="alert">
          <ErrorText error={error} context={null} />
        </p>
      )}
    </Modal>
  )
}
