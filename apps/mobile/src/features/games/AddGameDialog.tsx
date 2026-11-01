import { Button, Input, Popup } from 'antd-mobile'
import { FolderOpenOutlined, RightOutlined } from '@ant-design/icons'
import type { DirectoryReference, ShownError } from '@savedata-sync/shared'
import { ErrorText, PathText, useT } from '@savedata-sync/shared/ui'

/** 选定目录后确认添加；系统选择器同时申请持久读写权限。 */
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
    <Popup
      visible={isOpen}
      position="bottom"
      closeOnMaskClick={!isBusy}
      onClose={onCancel}
      style={{ '--z-index': '1100' }}
      bodyClassName="add-game-dialog"
      bodyStyle={{
        left: 12,
        right: 12,
        bottom: 'calc(12px + env(safe-area-inset-bottom))',
        width: 'auto',
        borderRadius: 12,
      }}
      destroyOnClose
    >
      <section role="dialog" aria-modal="true" aria-label={t('game.add')}>
        <h2>{t('game.add')}</h2>
        <button
          type="button"
          className="add-game-directory"
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
        </button>
        {directory && (
          <label className="field add-game-name">
            {t('game.name')}
            <Input
              aria-label={t('game.name')}
              value={gameName}
              maxLength={128}
              disabled={isBusy}
              onChange={onGameNameChange}
              placeholder={t('game.namePlaceholder')}
            />
          </label>
        )}
        {error && (
          <div className="pane-error" role="alert">
            <ErrorText error={error} context={null} />
          </div>
        )}
        <div className="add-game-footer">
          <Button fill="none" disabled={isBusy} onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button
            fill="none"
            color="primary"
            disabled={isBusy || !directory || !gameName.trim()}
            loading={isBusy}
            onClick={onConfirm}
          >
            {t('common.confirm')}
          </Button>
        </div>
      </section>
    </Popup>
  )
}
