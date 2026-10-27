import { Button, Card } from 'antd'
import type { UiSnapshot } from '../api.ts'

export function SettingsPage({
  snapshot,
  isMobile,
  isDisabled,
  isActive,
  onRevokeReceive,
}: {
  readonly snapshot: UiSnapshot | null
  readonly isMobile: boolean
  readonly isDisabled: boolean
  readonly isActive: boolean
  readonly onRevokeReceive: (rootId: string) => void
}): React.JSX.Element {
  return (
    <>
      <Card title="外观">
        <p>主题：跟随系统</p>
      </Card>
      {!isMobile && Boolean(snapshot?.grantedRoots.length) && (
        <Card title="接收目录">
          {snapshot?.grantedRoots.map((id) => (
            <div className="library-linked-row" key={id}>
              <span>
                {snapshot.roots.find((root) => root.rootId === id)?.displayName ?? '已授权目录'}
              </span>
              <Button disabled={isDisabled || isActive} onClick={() => onRevokeReceive(id)}>
                撤销接收授权
              </Button>
            </div>
          ))}
        </Card>
      )}
      <Card title="存档同步">
        <p>版本 0.1.0</p>
      </Card>
    </>
  )
}
