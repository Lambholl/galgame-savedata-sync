import { Alert, Descriptions, Empty, Table, Tag } from 'antd'
import type { TableProps } from 'antd'
import type {
  SyncEntry,
  SyncIssue,
  SyncPlan,
  SyncPlanEntry,
  SyncWriteOutcome,
} from '@savedata-sync/shared'
import { displayBytes, displayTime } from '../../components/display.ts'

const ACTIONS: Readonly<Record<SyncPlanEntry['action'], string>> = {
  'create-directory': '新建文件夹',
  'create-file': '新建文件',
  'replace-file': '覆盖文件',
  skip: '跳过相同内容',
  keep: '保留目标内容',
  conflict: '存在冲突',
}
const ISSUES: Readonly<Record<SyncIssue['code'], string>> = {
  'invalid-context': '项目或目录信息已变化',
  'scan-failed': '目录扫描未完成',
  'unreadable-entry': '条目读取失败',
  'unknown-content': '未读到完整文件内容',
  'name-conflict': '名称冲突',
  'type-conflict': '文件与文件夹同名',
  'resource-limit': '超出本次操作限制',
}
function entryView(
  entry: SyncEntry | undefined,
  id: string | null,
  isComplete: boolean,
): React.ReactNode {
  if (id === null) {
    return isComplete ? '不存在' : '扫描未完成，存在情况未知'
  }
  if (!entry) {
    return '条目属性未知'
  }
  return (
    <div className="library-sync-entry">
      <span>
        {entry.kind === 'directory' ? '文件夹' : `文件 · ${displayBytes(entry.sizeBytes)}`}
      </span>
      <small>{entry.modifiedAt === null ? '修改时间未知' : displayTime(entry.modifiedAt)}</small>
      {entry.error && <small>{entry.error.message}</small>}
    </div>
  )
}
/** 只展示已确认快照和共享比较结果；缺失、未知及文件夹属性分别显示。 */
export function SyncPlanView({
  plan,
  sourceLabel,
  targetLabel,
}: {
  readonly plan: SyncPlan
  readonly sourceLabel: string
  readonly targetLabel: string
}): React.JSX.Element {
  const source = new Map(plan.source.entries.map((item) => [item.entryId, item])),
    target = new Map(plan.target.entries.map((item) => [item.entryId, item]))
  const counts = (action: SyncPlanEntry['action']): number =>
    plan.entries.filter((item) => item.action === action).length
  const columns: TableProps<SyncPlanEntry>['columns'] = [
    {
      title: '相对位置',
      key: 'path',
      render: (_, item) => <span className="library-sync-path">{item.path.join(' / ')}</span>,
    },
    {
      title: '操作',
      key: 'action',
      width: 150,
      render: (_, item) => (
        <Tag
          color={
            item.action === 'conflict'
              ? 'error'
              : item.action === 'replace-file'
                ? 'warning'
                : 'default'
          }
        >
          {ACTIONS[item.action]}
        </Tag>
      ),
    },
    {
      title: '来源属性',
      key: 'source',
      render: (_, item) =>
        entryView(
          source.get(item.sourceEntryId ?? ''),
          item.sourceEntryId,
          plan.source.error === null,
        ),
    },
    {
      title: '目标当前属性',
      key: 'target',
      render: (_, item) =>
        entryView(
          target.get(item.targetEntryId ?? ''),
          item.targetEntryId,
          plan.target.error === null,
        ),
    },
  ]
  return (
    <div className="library-stack">
      <Descriptions
        size="small"
        column={1}
        items={[
          {
            key: 'source',
            label: '来源',
            children: <span className="library-sync-path">{sourceLabel}</span>,
          },
          {
            key: 'target',
            label: '目标',
            children: <span className="library-sync-path">{targetLabel}</span>,
          },
          {
            key: 'backup',
            label: '覆盖前保护',
            children: plan.shouldBackup
              ? '开启：先备份目标旧内容，最近保留 3 次'
              : '已关闭：覆盖后无法从本次备份恢复旧内容',
          },
          {
            key: 'files',
            label: '本次文件',
            children: `新建 ${counts('create-file')} 个，覆盖 ${counts('replace-file')} 个，内容 ${displayBytes(plan.totalFileBytes)}`,
          },
          {
            key: 'other',
            label: '其他处理',
            children: `新建文件夹 ${counts('create-directory')} 个，跳过 ${counts('skip')} 项，保留 ${counts('keep')} 项`,
          },
          ...(plan.shouldBackup
            ? [
                {
                  key: 'old',
                  label: '本次备份文件内容',
                  children: displayBytes(plan.backupFileBytes),
                },
              ]
            : []),
        ]}
      />
      {!plan.canExecute && (
        <Alert type="error" showIcon title="当前计划存在问题，请处理后重新扫描。" />
      )}
      {plan.issues.length > 0 && (
        <Table<SyncIssue>
          size="small"
          dataSource={[...plan.issues]}
          rowKey={(item) => `${item.side}/${item.code}/${item.path?.join('/') ?? ''}`}
          pagination={{ defaultPageSize: 10, hideOnSinglePage: true }}
          columns={[
            {
              title: '位置',
              key: 'path',
              render: (_, item) => item.path?.join(' / ') ?? '整个目录',
            },
            {
              title: '涉及一侧',
              key: 'side',
              render: (_, item) => ({ source: '来源', target: '目标', both: '两端' })[item.side],
            },
            { title: '问题', key: 'issue', render: (_, item) => ISSUES[item.code] },
          ]}
        />
      )}
      {plan.entries.length ? (
        <Table<SyncPlanEntry>
          size="small"
          columns={columns}
          dataSource={[...plan.entries]}
          rowKey={(item) => item.path.join('/')}
          pagination={{ defaultPageSize: 20, hideOnSinglePage: true }}
          scroll={{ x: 650 }}
        />
      ) : (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            plan.canExecute ? '两个目录均为空' : '当前无法列出可执行计划，请查看上方问题'
          }
        />
      )}
    </div>
  )
}

/** 只列原生已观察到的写入结果；跳过和保留项仍在计划中查看。 */
export function SyncOutcomeView({
  outcomes,
}: {
  readonly outcomes: readonly SyncWriteOutcome[]
}): React.JSX.Element {
  const status = (item: SyncWriteOutcome): string =>
    ({
      succeeded: '已完成',
      failed: '失败',
      cancelled: '已取消',
      'not-attempted': '未执行',
      unknown: '结果待确认',
    })[item.status]
  return (
    <Table<SyncWriteOutcome>
      size="small"
      dataSource={[...outcomes]}
      rowKey={(item) => item.path.join('/')}
      locale={{ emptyText: '本次没有需要写入的条目' }}
      pagination={{ defaultPageSize: 20, hideOnSinglePage: true }}
      columns={[
        {
          title: '相对位置',
          key: 'path',
          render: (_, item) => <span className="library-sync-path">{item.path.join(' / ')}</span>,
        },
        { title: '操作', key: 'action', render: (_, item) => ACTIONS[item.action] },
        {
          title: '实际结果',
          key: 'result',
          render: (_, item) => (
            <div className="library-sync-entry">
              <Tag
                color={
                  item.status === 'succeeded'
                    ? 'success'
                    : item.status === 'unknown' || item.status === 'failed'
                      ? 'error'
                      : 'default'
                }
              >
                {status(item)}
              </Tag>
              {item.error && <small>{item.error.message}</small>}
            </div>
          ),
        },
        {
          title: '已核实文件内容',
          key: 'size',
          render: (_, item) =>
            item.action === 'create-directory'
              ? '文件夹'
              : item.status === 'succeeded'
                ? displayBytes(item.sizeBytes)
                : '—',
        },
      ]}
      scroll={{ x: 560 }}
    />
  )
}
