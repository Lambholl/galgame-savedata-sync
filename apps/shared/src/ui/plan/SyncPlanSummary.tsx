import { useState, type ReactElement } from 'react'
import {
  DesktopOutlined,
  DownloadOutlined,
  ExclamationCircleOutlined,
  HistoryOutlined,
  MobileOutlined,
  RightOutlined,
  SafetyOutlined,
  StopOutlined,
} from '@ant-design/icons'
import type { SyncEntry, SyncPlan, SyncPlanEntry } from '../../sync/sync-contracts.ts'
import { fileKindOf } from '../../sync/snapshot-compare.ts'
import { formatBytes, formatShortDateTime } from '../../i18n/format.ts'
import type { Translate } from '../../i18n/translate.ts'
import { FileIcon } from '../files/FileIcon.tsx'
import { useLocale, useT } from '../i18n/i18n-context.ts'
import './sync-plan-summary.css'

/** 计划一端的显示信息。 */
export interface PlanEndpoint {
  /** 设备名，或“本机”“本机备份”等。 */
  readonly name: string
  /** 图标：电脑、手机或备份。 */
  readonly kind: 'pc' | 'phone' | 'backup'
}

/** SyncPlanSummary 的参数。 */
export interface SyncPlanSummaryProps {
  /** 要展示的固定计划；只读，执行仍使用原计划。 */
  readonly plan: SyncPlan
  /** 写出内容的一端。 */
  readonly source: PlanEndpoint
  /** 被写入的一端。 */
  readonly target: PlanEndpoint
  /** 被写入一端开启覆盖前备份时保留的份数；对端的份数读不到时为 null，只说明会备份。 */
  readonly backupKeepCount: number | null
}

type Group = 'replace' | 'create' | 'keep'

interface PlanRow {
  readonly entry: SyncPlanEntry
  readonly source: SyncEntry | undefined
  readonly target: SyncEntry | undefined
}

const ICONS = {
  pc: <DesktopOutlined />,
  phone: <MobileOutlined />,
  backup: <HistoryOutlined />,
} as const

function issueText(plan: SyncPlan, t: Translate): string | null {
  const issue = plan.issues[0]
  if (issue) {
    const where = issue.path?.join(' / ') ?? t('plan.wholeFolder')
    return `${where} · ${t(`plan.issue.${issue.code}`)}`
  }
  const conflict = plan.entries.find((item) => item.action === 'conflict')
  return conflict ? `${conflict.path.join(' / ')} · ${t('plan.conflict')}` : null
}

/**
 * 传输或恢复计划的摘要：路线、新建/覆盖/保留三个数字、备份与大小，
 * 再按动作分组列出文件；相同的文件只给数量，问题以一条横幅出现。
 */
export function SyncPlanSummary({
  plan,
  source,
  target,
  backupKeepCount,
}: SyncPlanSummaryProps): ReactElement {
  const t = useT()
  const locale = useLocale()
  const [openKey, setOpenKey] = useState<string | null>(null)
  const sources = new Map(plan.source.entries.map((item) => [item.entryId, item]))
  const targets = new Map(plan.target.entries.map((item) => [item.entryId, item]))
  const groups: Record<Group, PlanRow[]> = { replace: [], create: [], keep: [] }
  let same = 0
  for (const entry of plan.entries) {
    const row = {
      entry,
      source: sources.get(entry.sourceEntryId ?? ''),
      target: targets.get(entry.targetEntryId ?? ''),
    }
    if (entry.action === 'replace-file') {
      groups.replace.push(row)
    } else if (entry.action === 'create-file' || entry.action === 'create-directory') {
      groups.create.push(row)
    } else if (entry.action === 'keep') {
      groups.keep.push(row)
    } else if (entry.action === 'skip' && row.source?.kind !== 'directory') {
      same++
    }
  }
  const issue = issueText(plan, t)
  const now = Date.now()
  const size = (entry: SyncEntry | undefined): string =>
    entry?.sizeBytes === null || entry?.sizeBytes === undefined ? '—' : formatBytes(entry.sizeBytes)
  const time = (entry: SyncEntry | undefined): string =>
    entry?.modifiedAt === null || entry?.modifiedAt === undefined
      ? t('common.timeUnknown')
      : formatShortDateTime(entry.modifiedAt, locale, now)
  function rows(group: Group): ReactElement[] {
    return groups[group].map((row) => {
      const path = row.entry.path
      const key = path.join('/')
      const name = path[path.length - 1] ?? ''
      const parent = path.slice(0, -1).join(' / ')
      const shown = row.source ?? row.target
      const kind = fileKindOf(name, shown?.kind ?? 'file')
      const content = (
        <>
          <FileIcon kind={kind} marker="none" />
          <span className="ss-prow-name">
            {parent && <small>{parent} / </small>}
            {name}
          </span>
          <span className="ss-prow-change">
            {group === 'replace' ? (
              `${size(row.target)} → ${size(row.source)}`
            ) : group === 'create' ? (
              <span className="is-up">{kind === 'directory' ? '+' : `+${size(row.source)}`}</span>
            ) : (
              size(row.target)
            )}
          </span>
        </>
      )
      if (group !== 'replace') {
        return (
          <div className="ss-prow" key={key}>
            {content}
          </div>
        )
      }
      const isOpen = openKey === key
      const sourceTime = row.source?.modifiedAt ?? null
      const targetTime = row.target?.modifiedAt ?? null
      const newer =
        sourceTime === null || targetTime === null || sourceTime === targetTime
          ? null
          : sourceTime > targetTime
            ? 'source'
            : 'target'
      return (
        <div key={key}>
          <button
            type="button"
            className={`ss-prow${isOpen ? ' is-open' : ''}`}
            aria-expanded={isOpen}
            onClick={() => setOpenKey(isOpen ? null : key)}
          >
            {content}
            <RightOutlined className="ss-prow-chevron" />
          </button>
          {isOpen && (
            <div className="ss-pdetail">
              <div>
                <b>{t('plan.detailSource', { name: source.name })}</b>
                <span className={newer === 'source' ? 'is-newer' : ''}>{time(row.source)}</span>
                <span>{size(row.source)}</span>
              </div>
              <div>
                <b>{t('plan.detailTarget', { name: target.name })}</b>
                <span className={newer === 'target' ? 'is-newer' : ''}>{time(row.target)}</span>
                <span>{size(row.target)}</span>
              </div>
            </div>
          )}
        </div>
      )
    })
  }
  const hasChanges = groups.replace.length + groups.create.length > 0
  return (
    <div className="ss-plan">
      <div className="ss-route">
        <div className="ss-route-end is-source">
          <i>{ICONS[source.kind]}</i>
          <b>{source.name}</b>
          <small>{t('transfer.source')}</small>
        </div>
        <div className="ss-route-arrow" />
        <div className="ss-route-end">
          <i>{ICONS[target.kind]}</i>
          <b>{target.name}</b>
          <small>{t('transfer.target')}</small>
        </div>
      </div>
      <div className="ss-stats">
        <div className="is-create">
          <b>{groups.create.length}</b>
          <span>{t('plan.stat.create')}</span>
        </div>
        <div className="is-replace">
          <b>{groups.replace.length}</b>
          <span>{t('plan.stat.replace')}</span>
        </div>
        <div className="is-keep">
          <b>{groups.keep.length}</b>
          <span>{t('plan.stat.keep')}</span>
        </div>
      </div>
      <div className="ss-metaline">
        {plan.operation === 'restore' ? (
          <span className="is-on">
            <SafetyOutlined />
            {t('plan.restoreBackup')}
          </span>
        ) : plan.shouldBackup ? (
          <span className="is-on">
            <SafetyOutlined />
            {backupKeepCount === null
              ? t('plan.backupOnPlain')
              : t('plan.backupOn', { count: backupKeepCount })}
          </span>
        ) : (
          <span className="is-off">
            <StopOutlined />
            {t('plan.backupOff')}
          </span>
        )}
        {plan.operation === 'copy' && plan.totalFileBytes !== null && (
          <span>
            <DownloadOutlined />
            {t('plan.transferSize', { size: formatBytes(plan.totalFileBytes) })}
          </span>
        )}
      </div>
      {issue && (
        <div className="ss-banner" role="alert">
          <ExclamationCircleOutlined />
          <span>
            {issue}
            <small>{t('plan.issueHint')}</small>
          </span>
        </div>
      )}
      {groups.replace.length > 0 && (
        <section>
          <h3 className="ss-sec is-replace">
            <i />
            {t('plan.group.replace', { count: groups.replace.length })}
            <small>{t('plan.group.replaceHint')}</small>
          </h3>
          <div className="ss-group">{rows('replace')}</div>
        </section>
      )}
      {groups.create.length > 0 && (
        <section>
          <h3 className="ss-sec is-create">
            <i />
            {t('plan.group.create', { count: groups.create.length })}
          </h3>
          <div className="ss-group">{rows('create')}</div>
        </section>
      )}
      {groups.keep.length > 0 && (
        <section>
          <h3 className="ss-sec is-keep">
            <i />
            {t('plan.group.keep', { count: groups.keep.length })}
            <small>{t('plan.group.keepHint')}</small>
          </h3>
          <div className="ss-group">{rows('keep')}</div>
        </section>
      )}
      {!hasChanges && !issue && <p className="ss-plan-note">{t('plan.nothing')}</p>}
      {same > 0 && <p className="ss-plan-note">{t('plan.sameHidden', { count: same })}</p>}
    </div>
  )
}
