import { Button, Input, Popup } from 'antd-mobile'
import { FolderOpenOutlined, RightOutlined } from '@ant-design/icons'
import type { DirectoryReference } from '@savedata-sync/shared'

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
  readonly error: string
  readonly onChooseDirectory: () => void
  readonly onGameNameChange: (value: string) => void
  readonly onCancel: () => void
  readonly onConfirm: () => void
}): React.JSX.Element {
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
        borderRadius: 16,
      }}
      destroyOnClose
    >
      <section role="dialog" aria-modal="true" aria-label="添加游戏">
        <h2>添加游戏</h2>
        <button
          type="button"
          className="add-game-directory"
          disabled={isBusy}
          onClick={onChooseDirectory}
        >
          <FolderOpenOutlined aria-hidden="true" />
          <span>
            <strong>选择存档目录</strong>
            <small>{directory?.displayPath ?? directory?.displayName ?? '未选择目录'}</small>
          </span>
          <RightOutlined aria-hidden="true" />
        </button>
        {directory && (
          <label className="field add-game-name">
            游戏名称
            <Input
              aria-label="游戏名称"
              value={gameName}
              maxLength={128}
              disabled={isBusy}
              onChange={onGameNameChange}
              placeholder="输入游戏名称"
            />
          </label>
        )}
        {error && (
          <p className="pane-error" role="alert">
            {error}
          </p>
        )}
        <div className="add-game-footer">
          <Button fill="none" disabled={isBusy} onClick={onCancel}>
            取消
          </Button>
          <Button
            fill="none"
            color="primary"
            disabled={isBusy || !directory || !gameName.trim()}
            loading={isBusy}
            onClick={onConfirm}
          >
            确定
          </Button>
        </div>
      </section>
    </Popup>
  )
}
