import { Input } from 'antd-mobile'
import type { DirectoryLocation } from '@savedata-sync/shared'
import { Panel } from '../../components/Panel'

export function TransferPreviewPage({
  source,
  targetNames,
  isDisabled,
  previewMessage,
  onTargetNameChange,
}: {
  readonly source: DirectoryLocation | null
  readonly targetNames: Readonly<Record<string, string>>
  readonly isDisabled: boolean
  readonly previewMessage: string
  readonly onTargetNameChange: (entryId: string, value: string) => void
}): React.JSX.Element {
  return (
    <Panel title={`新建 ${source?.files.length ?? 0} 个文件`}>
      <div className="page-stack">
        {source?.files.map((file) => (
          <label className="field" key={file.entryId}>
            {file.name}
            <Input
              aria-label={`${file.name} 的目标名称`}
              value={targetNames[file.entryId] ?? file.name}
              disabled={isDisabled}
              onChange={(value) => onTargetNameChange(file.entryId, value)}
            />
          </label>
        ))}
      </div>
      {previewMessage && (
        <p className="notice notice-warning" role="status">
          {previewMessage}
        </p>
      )}
    </Panel>
  )
}
