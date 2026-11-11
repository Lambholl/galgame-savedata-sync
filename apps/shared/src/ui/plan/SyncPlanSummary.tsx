import { useState, type ReactElement } from 'react'
import {
  DesktopOutlined,
  DownloadOutlined,
  ExclamationCircleOutlined,
  HistoryOutlined,
  MobileOutlined,
  SafetyOutlined,
  StopOutlined,
} from '@ant-design/icons'
import type { SyncEntry, SyncPlan, SyncPlanEntry } from '../../sync/sync-contracts.ts'
import { fileKindOf } from '../../sync/snapshot-compare.ts'
import { formatBytes, formatShortDateTime } from '../../i18n/format.ts'
import type { Translate } from '../../i18n/translate.ts'
import { FileIcon } from '../files/FileIcon.tsx'
import { Expand, ExpandChevron } from '../expand/Expand.tsx'
import { useT } from '../i18n/i18n-context.ts'
import './sync-plan-summary.css'

/** 计划一端的显示信息。 */
export interface PlanEndpoint {
  /** 设备名，或“本机”“本机备份”等。 */
  readonly name: string
  /** 图标：电脑、移动端或备份。 */
  readonly kind: 'pc' | 'mobile' | 'backup'
}

/** SyncPlanSummary 的参数。 */
export interface SyncPlanSummaryProps {
  /** 要展示的计划。 */
  readonly plan: SyncPlan
  /** 写出内容的一端。 */
  readonly source: PlanEndpoint
  /** 被写入的一端。 */
  readonly target: PlanEndpoint
  /** 被写入一端开启写入前备份时保留的份数；为 null 时只说明会备份。 */
  readonly backupKeepCount: number | null
}

type Group = 'replace' | 'create' | 'keep' | 'delete'

interface PlanRow {
  readonly entry: SyncPlanEntry
  readonly source: SyncEntry | undefined
  readonly target: SyncEntry | undefined
}

const ICONS = {
  pc: <DesktopOutlined />,
  mobile: <MobileOutlined />,
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
 * 传输或恢复计划的摘要：路线，新建、覆盖、保留或删除三个数字，备份和大小，再按动作分组列出文件。
 * 相同的文件只给数量，问题显示成一条横幅。删除只在目标有的条目时，第三个数字和第三组用红色；
 * 来源目录为空时多一条横幅。
 */
export function SyncPlanSummary({
  plan,
  source,
  target,
  backupKeepCount,
}: SyncPlanSummaryProps): ReactElement {
  const t = useT()
  const [openKey, setOpenKey] = useState<string | null>(null)
  const sources = new Map(plan.source.entries.map((item) => [item.entryId, item]))
  const targets = new Map(plan.target.entries.map((item) => [item.entryId, item]))
  const groups: Record<Group, PlanRow[]> = { replace: [], create: [], keep: [], delete: [] }
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
    } else if (entry.action === 'delete-file' || entry.action === 'delete-directory') {
      groups.delete.push(row)
    } else if (entry.action === 'skip' && row.source?.kind !== 'directory') {
      same++
    }
  }
  const issue = issueText(plan, t)
  const size = (entry: SyncEntry | undefined): string =>
    entry?.sizeBytes === null || entry?.sizeBytes === undefined ? '—' : formatBytes(entry.sizeBytes)
  const time = (entry: SyncEntry | undefined): string =>
    entry?.modifiedAt === null || entry?.modifiedAt === undefined
      ? t('common.timeUnknown')
      : formatShortDateTime(entry.modifiedAt)
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
            ) : group === 'delete' ? (
              <span className="is-down">{kind === 'directory' ? '−' : `−${size(row.target)}`}</span>
            ) : (
              size(row.target)
            )}
          </span>
        </>
      )
      if (group !== 'replace') {
        return (
          <div className={`ss-prow${group === 'delete' ? ' is-delete' : ''}`} key={key}>
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
            className={`ss-prow ss-pressable${isOpen ? ' is-open' : ''}`}
            aria-expanded={isOpen}
            onClick={() => setOpenKey(isOpen ? null : key)}
          >
            {content}
            <ExpandChevron isOpen={isOpen} />
          </button>
          <Expand isOpen={isOpen}>
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
          </Expand>
        </div>
      )
    })
  }
  const hasChanges = groups.replace.length + groups.create.length + groups.delete.length > 0
  const isWipe = groups.delete.length > 0 && plan.source.entries.length === 0
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
        {plan.shouldDeleteExtras ? (
          <div className="is-delete">
            <b>{groups.delete.length}</b>
            <span>{t('plan.stat.delete')}</span>
          </div>
        ) : (
          <div className="is-keep">
            <b>{groups.keep.length}</b>
            <span>{t('plan.stat.keep')}</span>
          </div>
        )}
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
        {/* 写入前要退出游戏；底部只放开始按钮，这条提示放在计划里。 */}
        <span>
          <ExclamationCircleOutlined />
          {t('transfer.startNote')}
        </span>
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
      {isWipe && (
        <div className="ss-banner" role="alert">
          <ExclamationCircleOutlined />
          <span>{t('plan.wipeBanner')}</span>
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
      {groups.delete.length > 0 && (
        <section>
          <h3 className="ss-sec is-delete">
            <i />
            {t('plan.group.delete', { count: groups.delete.length })}
            <small>{t('plan.group.deleteHint')}</small>
          </h3>
          <div className="ss-group">{rows('delete')}</div>
        </section>
      )}
      {!hasChanges && !issue && <p className="ss-plan-note">{t('plan.nothing')}</p>}
      {same > 0 && <p className="ss-plan-note">{t('plan.sameHidden', { count: same })}</p>}
    </div>
  )
}
