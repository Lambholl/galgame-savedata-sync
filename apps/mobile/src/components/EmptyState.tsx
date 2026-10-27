import { FolderOutlined } from '@ant-design/icons'

export function EmptyState({ description }: { readonly description: string }): React.JSX.Element {
  return (
    <div className="empty-state">
      <FolderOutlined aria-hidden="true" />
      <p>{description}</p>
    </div>
  )
}
