import type {
  PosterHttpRequest,
  PosterImageCandidate,
  PosterWorkCandidate,
} from './poster-contracts.ts'
import { isPosterImageUrl } from './poster-contracts.ts'
import {
  distinctSubtitle,
  encodeQuery,
  joinDetail,
  readArray,
  readField,
  readText,
  sizeText,
} from './poster-json.ts'

const NEXTMOE_WORKS_URL = 'https://api.nextmoe.dev/v2/catalog/works'
const NEXTMOE_RATE_LIMIT_CODES = ['RATE_LIMITED', 'QUOTA_EXCEEDED']

/** 生成 NextMoe 的作品搜索请求。 */
export function createNextMoeWorksRequest(keyword: string, limit: number): PosterHttpRequest {
  return {
    method: 'GET',
    url: `${NEXTMOE_WORKS_URL}?${encodeQuery({ q: keyword, nsfw: 'true', limit: String(limit) })}`,
    headers: { Accept: 'application/json' },
    body: null,
  }
}

/** 生成列出 NextMoe 某部作品全部封面的请求。 */
export function createNextMoeCoversRequest(workId: string, limit: number): PosterHttpRequest {
  return {
    method: 'GET',
    url: `${NEXTMOE_WORKS_URL}/${encodeURIComponent(workId)}/covers?${encodeQuery({ nsfw: 'true', limit: String(limit) })}`,
    headers: { Accept: 'application/json' },
    body: null,
  }
}

function parseNextMoeWork(item: unknown): PosterWorkCandidate | null {
  const id = readText(readField(item, 'id'))
  const title = readText(readField(item, 'display_name'))
  // 作品 ID 会放进封面请求的路径，. 和 .. 会让路径指到别的接口。
  if (id === null || id === '.' || id === '..' || title === null) {
    return null
  }
  const coverUrl = readText(readField(readField(item, 'cover'), 'url'))
  return {
    kind: 'work',
    source: 'nextmoe',
    id,
    title,
    subtitle: distinctSubtitle(title, readText(readField(item, 'latin'))),
    detail: readText(readField(item, 'release_date')),
    previewUrl: coverUrl !== null && isPosterImageUrl(coverUrl) ? coverUrl : null,
  }
}

/**
 * 解析 NextMoe 的作品搜索响应；没有 ID 或名称的作品丢弃。
 *
 * @returns 响应没有 items 数组时返回 null。
 */
export function parseNextMoeWorksResponse(json: unknown): PosterWorkCandidate[] | null {
  const items = readArray(json, 'items')
  if (items === null) {
    return null
  }
  return items.map(parseNextMoeWork).filter((item): item is PosterWorkCandidate => item !== null)
}

/**
 * 解析 NextMoe 的作品封面响应，社区置顶的竖版封面排在前面，其余保持接口顺序；没有 ID 或图片的封面丢弃。
 *
 * @param work 封面所属的作品，候选沿用它的标题。
 * @returns 响应没有 items 数组时返回 null。
 */
export function parseNextMoeCoversResponse(
  json: unknown,
  work: PosterWorkCandidate,
): PosterImageCandidate[] | null {
  const items = readArray(json, 'items')
  if (items === null) {
    return null
  }
  const pinned: PosterImageCandidate[] = []
  const others: PosterImageCandidate[] = []
  for (const item of items) {
    const id = readText(readField(item, 'id'))
    const url = readText(readField(item, 'url'))
    if (id === null || url === null || !isPosterImageUrl(url)) {
      continue
    }
    const candidate: PosterImageCandidate = {
      kind: 'image',
      source: 'nextmoe',
      id,
      title: work.title,
      subtitle: readText(readField(item, 'cover_kind')),
      detail: joinDetail([sizeText(readField(item, 'width'), readField(item, 'height'))]),
      previewUrl: url,
      downloadUrl: url,
    }
    if (readField(item, 'portrait_pinned') === true) {
      pinned.push(candidate)
    } else {
      others.push(candidate)
    }
  }
  return [...pinned, ...others]
}

/** 判断 NextMoe 的错误响应是否表示限流。 */
export function isNextMoeRateLimited(json: unknown): boolean {
  const code = readText(readField(json, 'code'))
  return code !== null && NEXTMOE_RATE_LIMIT_CODES.includes(code)
}

/** 判断 NextMoe 的错误响应是否表示作品不存在。 */
export function isNextMoeNotFound(json: unknown): boolean {
  return readText(readField(json, 'code')) === 'NOT_FOUND'
}
