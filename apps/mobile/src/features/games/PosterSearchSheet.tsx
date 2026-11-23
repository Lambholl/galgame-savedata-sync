import { Button, SearchBar, Tabs } from 'antd-mobile'
import { LeftOutlined } from '@ant-design/icons'
import { POSTER_SOURCES } from '@savedata-sync/shared'
import type { PosterAdapter, PosterImageCandidate } from '@savedata-sync/shared'
import {
  POSTER_SOURCE_NAMES,
  PosterCandidateGrid,
  PosterSearchState,
  usePosterSearch,
  useT,
} from '@savedata-sync/shared/ui'
import { Sheet } from '../../components/Sheet'

/** 在线搜索封面的底部弹层：来源切换、关键词和候选网格；NextMoe 先选作品再选封面。 */
export function PosterSearchSheet({
  isOpen,
  gameName,
  adapter,
  savingId,
  onPick,
  onClose,
}: {
  readonly isOpen: boolean
  /** 打开时用它生成默认关键词。 */
  readonly gameName: string
  readonly adapter: PosterAdapter
  /** 正在保存的候选 id；不为 null 时弹层不能关闭，候选不能点。 */
  readonly savingId: string | null
  /** 选中一张图片时调用；保存成功后由调用方关闭弹层。 */
  readonly onPick: (candidate: PosterImageCandidate) => void
  readonly onClose: () => void
}): React.JSX.Element {
  const t = useT()
  return (
    <Sheet
      isOpen={isOpen}
      title={t('poster.searchTitle')}
      isBusy={savingId !== null}
      onClose={onClose}
    >
      {/* Sheet 关闭时销毁内容，下次打开重新用默认关键词搜索。 */}
      <PosterSearchContent
        gameName={gameName}
        adapter={adapter}
        savingId={savingId}
        onPick={onPick}
      />
    </Sheet>
  )
}

function PosterSearchContent({
  gameName,
  adapter,
  savingId,
  onPick,
}: {
  readonly gameName: string
  readonly adapter: PosterAdapter
  readonly savingId: string | null
  readonly onPick: (candidate: PosterImageCandidate) => void
}): React.JSX.Element {
  const t = useT()
  const search = usePosterSearch(gameName, adapter, onPick)
  const { work, status, candidates, setKeyword, selectSource, submit, retry, pick, leaveWork } =
    search
  const isSaving = savingId !== null
  return (
    <div className="poster-sheet">
      <SearchBar
        value={search.keyword}
        placeholder={t('poster.keyword')}
        aria-label={t('poster.keyword')}
        onChange={setKeyword}
        onSearch={() => submit(search.keyword)}
      />
      <Tabs
        activeKey={search.source}
        onChange={(key) => {
          // Tabs 回传的是 Tab 的 key 字符串，按来源列表找回 PosterSource。
          const next = POSTER_SOURCES.find((item) => item === key)
          if (next) {
            selectSource(next)
          }
        }}
      >
        {POSTER_SOURCES.map((item) => (
          <Tabs.Tab key={item} title={POSTER_SOURCE_NAMES[item]} disabled={isSaving} />
        ))}
      </Tabs>
      {work ? (
        <div className="poster-work-heading">
          <Button fill="none" size="small" disabled={isSaving} onClick={leaveWork}>
            <LeftOutlined /> {t('poster.works')}
          </Button>
          <span className="poster-work-title">{work.title}</span>
          {search.coverCount === null ? null : (
            <small>{t('poster.coverCount', { count: search.coverCount })}</small>
          )}
        </div>
      ) : null}
      <div className="poster-sheet-body">
        {status ? (
          <PosterSearchState status={status} onRetry={retry} />
        ) : (
          <PosterCandidateGrid
            candidates={candidates}
            previewUrls={search.previewUrls}
            savingId={savingId}
            isCompact
            onPick={pick}
          />
        )}
      </div>
    </div>
  )
}
