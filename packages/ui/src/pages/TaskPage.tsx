import type { UiTask } from '../api.ts'
import { TaskView } from '../TaskView.tsx'

export function TaskPage({
  tasks,
  isBusy,
  onCancel,
  onCleanup,
}: {
  readonly tasks: readonly UiTask[]
  readonly isBusy: boolean
  readonly onCancel: (id: string) => void
  readonly onCleanup: () => void
}): React.JSX.Element {
  return <TaskView tasks={tasks} isBusy={isBusy} onCancel={onCancel} onCleanup={onCleanup} />
}
