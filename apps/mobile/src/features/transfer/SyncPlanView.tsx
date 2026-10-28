import type {
  SyncEntry,
  SyncIssue,
  SyncPlan,
  SyncPlanEntry,
  SyncApplyResult,
} from '@savedata-sync/shared'
import { Panel } from '../../components/Panel'
import { displayBytes, displayTime } from './display'

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
function attributes(
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
    <>
      <span>
        {entry.kind === 'directory' ? '文件夹' : `文件 · ${displayBytes(entry.sizeBytes)}`}
      </span>
      <small>{displayTime(entry.modifiedAt)}</small>
      {entry.error && <small className="sync-error">{entry.error.message}</small>}
    </>
  )
}

/** 连续列出有变化的条目；仅隐藏 skip 展示，执行仍使用未修改的完整固定计划。 */
export function SyncPlanView({
  plan,
  sourceLabel,
  targetLabel,
}: {
  readonly plan: SyncPlan
  readonly sourceLabel: string
  readonly targetLabel: string
}): React.JSX.Element {
  const changes = plan.entries.filter((item) => item.action !== 'skip')
  const source = new Map(plan.source.entries.map((item) => [item.entryId, item]))
  const target = new Map(plan.target.entries.map((item) => [item.entryId, item]))
  const count = (action: SyncPlanEntry['action']): number =>
    plan.entries.filter((item) => item.action === action).length
  return (
    <>
      <Panel title="本次变化">
        <dl className="sync-facts">
          <dt>来源</dt>
          <dd>{sourceLabel}</dd>
          <dt>目标</dt>
          <dd>{targetLabel}</dd>
          <dt>覆盖前备份</dt>
          <dd>{plan.shouldBackup ? '开启，最近保留 3 次' : '本次关闭覆盖前备份'}</dd>
        </dl>
        <p>
          新建 {count('create-file')} 个文件，覆盖 {count('replace-file')} 个文件，内容{' '}
          {displayBytes(plan.totalFileBytes)}。
        </p>
        <p>
          新建文件夹 {count('create-directory')} 个，跳过 {count('skip')} 项，保留 {count('keep')}{' '}
          项。
        </p>
        {plan.shouldBackup && <p>本次备份文件内容：{displayBytes(plan.backupFileBytes)}</p>}
        {!plan.canExecute && (
          <p className="notice notice-error" role="alert">
            当前计划存在问题，请处理后重新扫描。
          </p>
        )}
        {plan.canExecute &&
          !plan.entries.some((item) =>
            ['create-file', 'replace-file', 'create-directory'].includes(item.action),
          ) && <p className="notice">无需复制</p>}
        {plan.issues.map((issue, index) => (
          <p className="sync-error" key={index}>
            {issue.path?.join(' / ') ?? '整个目录'} ·{' '}
            {{ source: '来源', target: '目标', both: '两端' }[issue.side]}：{ISSUES[issue.code]}
          </p>
        ))}
      </Panel>
      <Panel title="逐项计划">
        {changes.map((item) => (
          <article className="sync-entry" key={item.path.join('/')}>
            <strong>{item.path.join(' / ')}</strong>
            <span className={item.action === 'conflict' ? 'sync-error' : ''}>
              {ACTIONS[item.action]}
            </span>
            <div className="sync-attributes">
              <div>
                <b>来源</b>
                {attributes(
                  source.get(item.sourceEntryId ?? ''),
                  item.sourceEntryId,
                  plan.source.error === null,
                )}
              </div>
              <div>
                <b>目标当前</b>
                {attributes(
                  target.get(item.targetEntryId ?? ''),
                  item.targetEntryId,
                  plan.target.error === null,
                )}
              </div>
            </div>
          </article>
        ))}
        {!changes.length && (
          <p>
            {!plan.canExecute
              ? '请查看扫描问题'
              : plan.entries.length
                ? '两端内容相同，无需传输'
                : '两个目录均为空'}
          </p>
        )}
      </Panel>
    </>
  )
}

/** 实际写入结果与备份、清理分开显示；未知结果引导重扫，不提供重放操作。 */
export function SyncOutcomeView({
  result,
}: {
  readonly result: SyncApplyResult
}): React.JSX.Element {
  return (
    <Panel title="目标实际写入结果">
      {result.error && <p className="notice notice-error">{result.error.message}</p>}
      {result.cleanupError && (
        <p className="notice notice-error">清理未完成：{result.cleanupError.message}</p>
      )}
      {result.backupId && <p>已保存覆盖前备份。</p>}
      {!result.outcomes.length && <p>本次没有需要写入的条目。</p>}
      {result.outcomes.map((item) => (
        <article className="sync-entry" key={item.path.join('/')}>
          <strong>{item.path.join(' / ')}</strong>
          <span>
            {
              {
                succeeded: '已完成',
                failed: '失败',
                cancelled: '已取消',
                'not-attempted': '未执行',
                unknown: '结果待确认',
              }[item.status]
            }
          </span>
          {item.status === 'succeeded' && (
            <small>
              {item.action === 'create-directory'
                ? '文件夹'
                : `已核实 ${displayBytes(item.sizeBytes)}`}
            </small>
          )}
          {item.error && <small className="sync-error">{item.error.message}</small>}
        </article>
      ))}
    </Panel>
  )
}
