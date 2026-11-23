import type { PosterHttpRequest, PosterImageCandidate } from './poster-contracts.ts'
import { isPosterImageUrl } from './poster-contracts.ts'
import { distinctSubtitle, encodeQuery, readArray, readField, readText } from './poster-json.ts'

const BANGUMI_SEARCH_URL = 'https://api.bgm.tv/v0/search/subjects'
/** Bangumi 条目类型里的“游戏”。 */
const BANGUMI_GAME_TYPE = 4

/** 生成 Bangumi 的游戏条目搜索请求。 */
export function createBangumiSearchRequest(keyword: string, limit: number): PosterHttpRequest {
  return {
    method: 'POST',
    url: `${BANGUMI_SEARCH_URL}?${encodeQuery({ limit: String(limit), offset: '0' })}`,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      keyword,
      sort: 'match',
      filter: { type: [BANGUMI_GAME_TYPE], nsfw: true },
    }),
  }
}

function parseBangumiItem(item: unknown): PosterImageCandidate | null {
  const id = readField(item, 'id')
  const images = readField(item, 'images')
  const downloadUrl = readText(readField(images, 'large'))
  const previewUrl = readText(readField(images, 'common')) ?? downloadUrl
  const name = readText(readField(item, 'name'))
  const title = readText(readField(item, 'name_cn')) ?? name
  if (
    readField(item, 'type') !== BANGUMI_GAME_TYPE ||
    typeof id !== 'number' ||
    !Number.isSafeInteger(id) ||
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
    source: 'bangumi',
    id: String(id),
    title,
    subtitle: distinctSubtitle(title, name),
    detail: readText(readField(item, 'date')),
    previewUrl,
    downloadUrl,
  }
}

/**
 * 解析 Bangumi 的条目搜索响应；不是游戏、没有标题或没有原图的条目丢弃。
 *
 * @returns 响应没有 data 数组时返回 null。
 */
export function parseBangumiSearchResponse(json: unknown): PosterImageCandidate[] | null {
  const items = readArray(json, 'data')
  if (items === null) {
    return null
  }
  return items.map(parseBangumiItem).filter((item): item is PosterImageCandidate => item !== null)
}
