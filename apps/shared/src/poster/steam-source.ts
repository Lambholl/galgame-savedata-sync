import type { PosterHttpRequest, PosterImageCandidate } from './poster-contracts.ts'
import { isPosterImageUrl } from './poster-contracts.ts'
import { encodeQuery, readArray, readField, readText } from './poster-json.ts'

const STEAM_SEARCH_URL = 'https://store.steampowered.com/api/storesearch/'
const STEAM_ITEMS_URL = 'https://api.steampowered.com/IStoreBrowseService/GetItems/v1/'
const STEAM_ASSET_BASE_URL = 'https://shared.akamai.steamstatic.com/store_item_assets/'
const STEAM_FILENAME_PLACEHOLDER = '${FILENAME}'
const STEAM_LANGUAGE = 'schinese'
const STEAM_COUNTRY = 'CN'

/** Steam 搜索结果里的一个应用。 */
export interface SteamApp {
  readonly appId: number
  readonly name: string
}

/** 生成 Steam 商店搜索请求。 */
export function createSteamSearchRequest(keyword: string): PosterHttpRequest {
  return {
    method: 'GET',
    url: `${STEAM_SEARCH_URL}?${encodeQuery({ term: keyword, l: STEAM_LANGUAGE, cc: STEAM_COUNTRY })}`,
    headers: { Accept: 'application/json' },
    body: null,
  }
}

/**
 * 解析 Steam 商店搜索响应，取前 limit 个应用；没有 ID 或名称的条目丢弃。
 *
 * @returns 响应没有 items 数组时返回 null。
 */
export function parseSteamSearchResponse(json: unknown, limit: number): SteamApp[] | null {
  const items = readArray(json, 'items')
  if (items === null) {
    return null
  }
  const apps: SteamApp[] = []
  for (const item of items) {
    const appId = readField(item, 'id')
    const name = readText(readField(item, 'name'))
    if (typeof appId === 'number' && Number.isSafeInteger(appId) && appId > 0 && name !== null) {
      apps.push({ appId, name })
    }
    if (apps.length === limit) {
      break
    }
  }
  return apps
}

/** 生成按应用 ID 批量读取商店素材的请求。 */
export function createSteamAssetsRequest(apps: readonly SteamApp[]): PosterHttpRequest {
  const input = {
    ids: apps.map((app) => ({ appid: app.appId })),
    context: { language: STEAM_LANGUAGE, country_code: STEAM_COUNTRY },
    data_request: { include_assets: true },
  }
  return {
    method: 'GET',
    url: `${STEAM_ITEMS_URL}?${encodeQuery({ input_json: JSON.stringify(input) })}`,
    headers: { Accept: 'application/json' },
    body: null,
  }
}

function assetUrl(format: string, fileName: string | null): string | null {
  if (fileName === null) {
    return null
  }
  const url = `${STEAM_ASSET_BASE_URL}${format.replace(STEAM_FILENAME_PLACEHOLDER, fileName)}`
  return isPosterImageUrl(url) ? url : null
}

/**
 * 解析商店素材响应，按 apps 的顺序生成候选；没有竖版封面（library_capsule）的应用丢弃。
 *
 * @returns 响应没有 response.store_items 数组时返回 null。
 */
export function parseSteamAssetsResponse(
  json: unknown,
  apps: readonly SteamApp[],
): PosterImageCandidate[] | null {
  const items = readArray(readField(json, 'response'), 'store_items')
  if (items === null) {
    return null
  }
  const capsules = new Map<number, { previewUrl: string; downloadUrl: string }>()
  for (const item of items) {
    const appId = readField(item, 'appid')
    const assets = readField(item, 'assets')
    const format = readText(readField(assets, 'asset_url_format'))
    // 新上架游戏的文件名带一段 hash，只能按接口给出的格式拼地址，不能套固定路径。
    if (
      typeof appId !== 'number' ||
      format === null ||
      !format.includes(STEAM_FILENAME_PLACEHOLDER)
    ) {
      continue
    }
    const previewUrl = assetUrl(format, readText(readField(assets, 'library_capsule')))
    if (previewUrl === null) {
      continue
    }
    const downloadUrl =
      assetUrl(format, readText(readField(assets, 'library_capsule_2x'))) ?? previewUrl
    capsules.set(appId, { previewUrl, downloadUrl })
  }
  return apps.flatMap((app): PosterImageCandidate[] => {
    const capsule = capsules.get(app.appId)
    return capsule === undefined
      ? []
      : [
          {
            kind: 'image',
            source: 'steam',
            id: String(app.appId),
            title: app.name,
            subtitle: null,
            detail: null,
            ...capsule,
          },
        ]
  })
}
