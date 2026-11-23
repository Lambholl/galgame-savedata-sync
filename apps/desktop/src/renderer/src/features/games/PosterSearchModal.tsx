import { Button, Input, Modal, Segmented } from 'antd'
import { ArrowLeftOutlined } from '@ant-design/icons'
import { POSTER_SOURCES } from '@savedata-sync/shared'
import type { PosterAdapter, PosterImageCandidate, PosterSource } from '@savedata-sync/shared'
import {
  POSTER_SOURCE_NAMES,
  PosterCandidateGrid,
  PosterSearchState,
  usePosterSearch,
  useT,
} from '@savedata-sync/shared/ui'

/** 在线搜索封面的弹层：来源切换、关键词和候选网格；NextMoe 先选作品再选封面。 */
export function PosterSearchModal({
  open,
  gameName,
  adapter,
  savingId,
  onPick,
  onClose,
}: {
  readonly open: boolean
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
  const isSaving = savingId !== null
  return (
    <Modal
      open={open}
      title={t('poster.searchTitle')}
      width={880}
      footer={null}
      closable={!isSaving}
      keyboard={!isSaving}
      mask={{ closable: !isSaving }}
      destroyOnHidden
      onCancel={onClose}
    >
      <PosterSearchContent
        gameName={gameName}
        adapter={adapter}
        savingId={savingId}
        onPick={onPick}
      />
    </Modal>
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
  const { work, status, candidates, selectSource, retry, pick, leaveWork } = search
  const isSaving = savingId !== null
  return (
    <>
      <div className="poster-search-bar">
        <Segmented<PosterSource>
          value={search.source}
          disabled={isSaving}
          options={POSTER_SOURCES.map((item) => ({
            value: item,
            label: POSTER_SOURCE_NAMES[item],
          }))}
          onChange={selectSource}
        />
        <Input.Search
          value={search.keyword}
          allowClear
          disabled={isSaving}
          enterButton={t('poster.searchButton')}
          placeholder={t('poster.keyword')}
          aria-label={t('poster.keyword')}
          onChange={(event) => search.setKeyword(event.target.value)}
          onSearch={(value, _event, info) => {
            // 点清除图标也会触发 onSearch，这时只清空输入框。
            if (info?.source !== 'clear') {
              search.submit(value)
            }
          }}
        />
      </div>
      {work ? (
        <div className="poster-work-heading">
          <Button type="text" icon={<ArrowLeftOutlined />} disabled={isSaving} onClick={leaveWork}>
            {t('poster.works')}
          </Button>
          <span className="poster-work-title" title={work.title}>
            {work.title}
          </span>
          {search.coverCount === null ? null : (
            <small>{t('poster.coverCount', { count: search.coverCount })}</small>
          )}
        </div>
      ) : null}
      <div className="poster-search-body">
        {status ? (
          <PosterSearchState status={status} onRetry={retry} />
        ) : (
          <PosterCandidateGrid
            candidates={candidates}
            previewUrls={search.previewUrls}
            savingId={savingId}
            isCompact={false}
            onPick={pick}
          />
        )}
      </div>
    </>
  )
}
