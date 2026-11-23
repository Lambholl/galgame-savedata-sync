import { useEffect, useState } from 'react'
import { PosterSearchError, createDefaultPosterKeyword } from '../../poster/poster-contracts.ts'
import type {
  PosterCandidate,
  PosterImageCandidate,
  PosterSearchErrorCode,
  PosterSource,
  PosterWorkCandidate,
} from '../../poster/poster-contracts.ts'
import type { PosterAdapter } from '../../poster/poster-adapter.ts'
import type { PosterSearchStatus } from './PosterSearchState.tsx'
import { usePreviewUrls } from './use-preview-urls.ts'

/** usePosterSearch 返回的搜索状态和操作。 */
export interface PosterSearch {
  /** 来源切换控件选中的来源。 */
  readonly source: PosterSource
  /** 关键词输入框的内容。 */
  readonly keyword: string
  /** 正在看封面的 NextMoe 作品；在看搜索结果时为 null。 */
  readonly work: PosterWorkCandidate | null
  /** 结果区没有候选可显示时的状态；有候选时为 null。 */
  readonly status: PosterSearchStatus | null
  /** 当前结果区的候选；加载中和失败时为空。 */
  readonly candidates: readonly PosterCandidate[]
  /** 已经下好的预览图地址，键是候选 id。 */
  readonly previewUrls: ReadonlyMap<string, string>
  /** 正在看作品且封面已列出时为封面张数，其余时候为 null。 */
  readonly coverCount: number | null
  /** 改关键词输入框的内容，不发起搜索。 */
  readonly setKeyword: (keyword: string) => void
  /** 换来源，并用输入框里的关键词搜索。 */
  readonly selectSource: (source: PosterSource) => void
  /** 用当前来源搜索 keyword；去掉首尾空白后为空时不做任何事。同样的关键词也会重新请求。 */
  readonly submit: (keyword: string) => void
  /** 重新请求当前的搜索或作品封面列表。 */
  readonly retry: () => void
  /** 点选候选：作品候选进入它的封面列表，图片候选交给 onPick。 */
  readonly pick: (candidate: PosterCandidate) => void
  /** 从作品封面列表回到搜索结果。 */
  readonly leaveWork: () => void
}

/** 一次搜索；attempt 在每次点搜索或重试时加一，同样的关键词也会重新请求。 */
interface SearchQuery {
  readonly source: PosterSource
  readonly keyword: string
  readonly attempt: number
}

/** 正在看的 NextMoe 作品；attempt 在重试时加一。 */
interface WorkQuery {
  readonly work: PosterWorkCandidate
  readonly attempt: number
}

type Outcome =
  | { readonly kind: 'done'; readonly items: readonly PosterCandidate[] }
  | { readonly kind: 'failed'; readonly source: PosterSource; readonly code: PosterSearchErrorCode }

/** 一次请求的结果；key 和当前请求的 key 不同时说明结果已过期，按加载中显示。 */
interface Loaded {
  readonly key: string
  readonly outcome: Outcome
}

function failedOutcome(source: PosterSource, cause: unknown): Outcome {
  // PosterSearchClient 只以 PosterSearchError reject；instanceof 用来收窄 unknown。
  return {
    kind: 'failed',
    source,
    code: cause instanceof PosterSearchError ? cause.code : 'network',
  }
}

/**
 * 在线搜索封面的状态：挂载时用 gameName 生成的默认关键词搜索 VNDB，NextMoe 先选作品再列封面，并下载候选的预览图。
 * 卸载时丢弃未完成的结果，释放预览图地址。
 *
 * @param onPick 点选图片候选时调用。
 */
export function usePosterSearch(
  gameName: string,
  adapter: Pick<PosterAdapter, 'search' | 'listWorkCovers' | 'downloadImage'>,
  onPick: (candidate: PosterImageCandidate) => void,
): PosterSearch {
  const [source, setSource] = useState<PosterSource>('vndb')
  const [keyword, setKeyword] = useState(() => createDefaultPosterKeyword(gameName))
  const [search, setSearch] = useState<SearchQuery>(() => ({
    source: 'vndb',
    keyword: createDefaultPosterKeyword(gameName),
    attempt: 0,
  }))
  const [work, setWork] = useState<WorkQuery | null>(null)
  const [searchResult, setSearchResult] = useState<Loaded | null>(null)
  const [coversResult, setCoversResult] = useState<Loaded | null>(null)
  const searchKey = `${search.attempt}\n${search.source}\n${search.keyword}`
  const coversKey = work ? `${work.attempt}\n${work.work.id}` : ''

  useEffect(() => {
    let isCurrent = true
    adapter.search(search.source, search.keyword).then(
      (items) => {
        if (isCurrent) {
          setSearchResult({ key: searchKey, outcome: { kind: 'done', items } })
        }
      },
      (cause: unknown) => {
        if (isCurrent) {
          setSearchResult({ key: searchKey, outcome: failedOutcome(search.source, cause) })
        }
      },
    )
    return () => {
      isCurrent = false
    }
  }, [adapter, search, searchKey])

  useEffect(() => {
    if (!work) {
      return
    }
    let isCurrent = true
    adapter.listWorkCovers(work.work).then(
      (items) => {
        if (isCurrent) {
          setCoversResult({ key: coversKey, outcome: { kind: 'done', items } })
        }
      },
      (cause: unknown) => {
        if (isCurrent) {
          setCoversResult({ key: coversKey, outcome: failedOutcome('nextmoe', cause) })
        }
      },
    )
    return () => {
      isCurrent = false
    }
  }, [adapter, work, coversKey])

  const outcome = work
    ? coversResult?.key === coversKey
      ? coversResult.outcome
      : null
    : searchResult?.key === searchKey
      ? searchResult.outcome
      : null
  const candidates = outcome?.kind === 'done' ? outcome.items : []
  let status: PosterSearchStatus | null = null
  if (!outcome) {
    status = { kind: 'loading' }
  } else if (outcome.kind === 'failed') {
    status = { kind: 'failed', source: outcome.source, code: outcome.code }
  } else if (candidates.length === 0) {
    status = work
      ? { kind: 'no-covers' }
      : { kind: 'empty', source: search.source, keyword: search.keyword }
  }
  const loadedPreviews = usePreviewUrls(
    candidates.flatMap((item) => (item.previewUrl ? [item.previewUrl] : [])),
    adapter,
  )
  const previewUrls = new Map<string, string>()
  for (const item of candidates) {
    const url = item.previewUrl ? loadedPreviews.get(item.previewUrl) : undefined
    if (url) {
      previewUrls.set(item.id, url)
    }
  }

  function runSearch(nextSource: PosterSource, nextKeyword: string): void {
    const query = nextKeyword.trim()
    if (query === '') {
      return
    }
    setWork(null)
    setSearch((current) => ({ source: nextSource, keyword: query, attempt: current.attempt + 1 }))
  }

  return {
    source,
    keyword,
    work: work?.work ?? null,
    status,
    candidates,
    previewUrls,
    coverCount: work && outcome?.kind === 'done' ? candidates.length : null,
    setKeyword,
    selectSource(next) {
      setSource(next)
      runSearch(next, keyword)
    },
    submit: (value) => runSearch(source, value),
    retry() {
      if (work) {
        setWork({ ...work, attempt: work.attempt + 1 })
      } else {
        setSearch({ ...search, attempt: search.attempt + 1 })
      }
    },
    pick(candidate) {
      if (candidate.kind === 'work') {
        setWork({ work: candidate, attempt: 0 })
      } else {
        onPick(candidate)
      }
    },
    leaveWork: () => setWork(null),
  }
}
