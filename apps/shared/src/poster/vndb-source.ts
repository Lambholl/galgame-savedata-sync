import type { PosterHttpRequest, PosterImageCandidate } from './poster-contracts.ts'
import { isPosterImageUrl } from './poster-contracts.ts'
import { distinctSubtitle, joinDetail, readArray, readField, readText } from './poster-json.ts'

const VNDB_SEARCH_URL = 'https://api.vndb.org/kana/vn'
const VNDB_FIELDS = [
  'title',
  'alttitle',
  'titles.lang',
  'titles.title',
  'released',
  'image.url',
  'image.thumbnail',
  'developers.name',
  'developers.original',
].join(',')
const CHINESE_LANGUAGES = ['zh-Hans', 'zh-Hant']
const MAX_DEVELOPERS = 3

/** 生成 VNDB 的作品搜索请求。 */
export function createVndbSearchRequest(keyword: string, limit: number): PosterHttpRequest {
  return {
    method: 'POST',
    url: VNDB_SEARCH_URL,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    // searchrank 只能配顶层的 search 过滤器，加别的过滤条件时 VNDB 返回 400。
    body: JSON.stringify({
      filters: ['search', '=', keyword],
      fields: VNDB_FIELDS,
      sort: 'searchrank',
      results: limit,
    }),
  }
}

function chineseTitle(titles: readonly unknown[] | null): string | null {
  for (const item of titles ?? []) {
    const language = readText(readField(item, 'lang'))
    const title = readText(readField(item, 'title'))
    if (language !== null && CHINESE_LANGUAGES.includes(language) && title !== null) {
      return title
    }
  }
  return null
}

function developerNames(developers: readonly unknown[] | null): string | null {
  const names = (developers ?? [])
    .map((item) => readText(readField(item, 'original')) ?? readText(readField(item, 'name')))
    .filter((name): name is string => name !== null)
    .slice(0, MAX_DEVELOPERS)
  return names.length === 0 ? null : names.join(' / ')
}

function parseVndbItem(item: unknown): PosterImageCandidate | null {
  const id = readText(readField(item, 'id'))
  const image = readField(item, 'image')
  const original = readText(readField(image, 'url'))
  const thumbnail = readText(readField(image, 'thumbnail'))
  const downloadUrl = original ?? thumbnail
  const previewUrl = thumbnail ?? original
  const romanTitle = readText(readField(item, 'title'))
  // title 是罗马字标题，alttitle 是原名；中文名只在 titles 里。
  const title =
    chineseTitle(readArray(item, 'titles')) ?? readText(readField(item, 'alttitle')) ?? romanTitle
  if (
    id === null ||
    title === null ||
    downloadUrl === null ||
    previewUrl === null ||
    !isPosterImageUrl(downloadUrl) ||
    !isPosterImageUrl(previewUrl)
  ) {
    return null
  }
  return {
    kind: 'image',
    source: 'vndb',
    id,
    title,
    subtitle: distinctSubtitle(title, romanTitle),
    detail: joinDetail([
      readText(readField(item, 'released')),
      developerNames(readArray(item, 'developers')),
    ]),
    previewUrl,
    downloadUrl,
  }
}

/**
 * 解析 VNDB 的作品搜索响应；没有 ID、标题或图片的条目丢弃。
 *
 * @returns 响应没有 results 数组时返回 null。
 */
export function parseVndbSearchResponse(json: unknown): PosterImageCandidate[] | null {
  const results = readArray(json, 'results')
  if (results === null) {
    return null
  }
  return results.map(parseVndbItem).filter((item): item is PosterImageCandidate => item !== null)
}
