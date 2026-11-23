import type { ReactElement } from 'react'
import { Button, Spin } from 'antd'
import { RightOutlined } from '@ant-design/icons'
import type { PosterCandidate } from '../../poster/poster-contracts.ts'
import { useT } from '../i18n/i18n-context.ts'
import { PosterCover } from './PosterCover.tsx'
import { posterCandidateName } from './poster-labels.ts'
import '../games/game-card.css'
import './poster.css'

/** PosterCandidateGrid 的参数。 */
export interface PosterCandidateGridProps {
  /** 搜索结果，按传入顺序排列；候选 id 在列表内唯一。 */
  readonly candidates: readonly PosterCandidate[]
  /** 已经可以显示的预览图地址，键是候选 id；没有的候选显示占位封面。 */
  readonly previewUrls: ReadonlyMap<string, string>
  /** 正在保存的候选 id；不为 null 时这张显示加载指示，其余候选不能点。 */
  readonly savingId: string | null
  /** 紧凑排版：固定三列、间距收小，和手机上的游戏卡片网格一致；否则按宽度自动排列。 */
  readonly isCompact: boolean
  /** 点选候选时调用；savingId 不为 null 时不调用。 */
  readonly onPick: (candidate: PosterCandidate) => void
}

/** 封面候选网格：3:4 预览图、名称和补充信息；作品候选带“选封面”角标。 */
export function PosterCandidateGrid({
  candidates,
  previewUrls,
  savingId,
  isCompact,
  onPick,
}: PosterCandidateGridProps): ReactElement {
  return (
    <div className={`ss-poster-grid${isCompact ? ' is-compact' : ''}`}>
      {candidates.map((candidate) => (
        <CandidateTile
          key={candidate.id}
          candidate={candidate}
          previewUrl={previewUrls.get(candidate.id) ?? null}
          isSaving={savingId === candidate.id}
          isDisabled={savingId !== null && savingId !== candidate.id}
          onPick={() => {
            if (savingId === null) {
              onPick(candidate)
            }
          }}
        />
      ))}
    </div>
  )
}

function CandidateTile({
  candidate,
  previewUrl,
  isSaving,
  isDisabled,
  onPick,
}: {
  readonly candidate: PosterCandidate
  readonly previewUrl: string | null
  readonly isSaving: boolean
  readonly isDisabled: boolean
  readonly onPick: () => void
}): ReactElement {
  const t = useT()
  const name = posterCandidateName(candidate, t)
  // 名称已经换成封面类别时，不再重复显示类别。
  const subtitle = name === candidate.title ? candidate.subtitle : null
  return (
    <Button
      type="text"
      block
      className="ss-game-card ss-poster-candidate"
      title={candidate.title}
      disabled={isDisabled}
      onClick={onPick}
      onDragStart={(event) => event.preventDefault()}
    >
      <PosterCover
        imageUrl={previewUrl}
        placeholderText={candidate.title}
        coverIndex={0}
        size="card"
      >
        {candidate.kind === 'work' ? (
          <span className="ss-poster-chip">
            {t('poster.pickCovers')} <RightOutlined />
          </span>
        ) : null}
        {isSaving ? (
          <span className="ss-poster-saving">
            <Spin />
          </span>
        ) : null}
      </PosterCover>
      <span className="ss-game-card-name">{name}</span>
      {subtitle ? <span className="ss-game-card-subtitle">{subtitle}</span> : null}
      {candidate.detail ? <span className="ss-game-card-subtitle">{candidate.detail}</span> : null}
    </Button>
  )
}
