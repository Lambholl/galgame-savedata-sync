import type {
  PosterCandidate,
  PosterClock,
  PosterHttpExecutor,
  PosterHttpRequest,
  PosterHttpResponse,
  PosterImageCandidate,
  PosterSource,
  PosterWorkCandidate,
} from './poster-contracts.ts'
import { POSTER_LIMITS, PosterSearchError } from './poster-contracts.ts'
import { parseJsonBody } from './poster-json.ts'
import { createBangumiSearchRequest, parseBangumiSearchResponse } from './bangumi-source.ts'
import {
  createNextMoeCoversRequest,
  createNextMoeWorksRequest,
  isNextMoeNotFound,
  isNextMoeRateLimited,
  parseNextMoeCoversResponse,
  parseNextMoeWorksResponse,
} from './nextmoe-source.ts'
import {
  createSteamAssetsRequest,
  createSteamSearchRequest,
  parseSteamAssetsResponse,
  parseSteamSearchResponse,
} from './steam-source.ts'
import { createVndbSearchRequest, parseVndbSearchResponse } from './vndb-source.ts'

/** 各来源两次请求之间的最小间隔，单位毫秒；没有列出的来源不限。 */
export const POSTER_REQUEST_INTERVALS_MS: Readonly<Partial<Record<PosterSource, number>>> = {
  vndb: 1550,
  nextmoe: 1300,
}

const HTTP_TOO_MANY_REQUESTS = 429
const HTTP_NOT_FOUND = 404

function isSuccess(status: number): boolean {
  return status >= 200 && status <= 299
}

/**
 * 封面搜索：按来源生成请求、交给执行器、解析响应。同一个实例内按 POSTER_REQUEST_INTERVALS_MS 给各来源排队，
 * 一个应用进程只应创建一个实例。
 */
export class PosterSearchClient {
  readonly #execute: PosterHttpExecutor
  readonly #clock: PosterClock
  readonly #nextRequestAt = new Map<PosterSource, number>()

  constructor(execute: PosterHttpExecutor, clock: PosterClock) {
    this.#execute = execute
    this.#clock = clock
  }

  /**
   * 按关键词搜索一个来源，最多返回 POSTER_LIMITS.maxSearchResults 条。NextMoe 返回作品候选，其余来源返回封面候选。
   *
   * @param keyword 原样发送，只去掉首尾空白。
   * @returns 关键词为空白时不发请求，返回空数组。
   * @throws PosterSearchError 请求失败、来源限流或响应格式不符时 reject。
   */
  async search(source: PosterSource, keyword: string): Promise<PosterCandidate[]> {
    const query = keyword.trim()
    if (query === '') {
      return []
    }
    const limit = POSTER_LIMITS.maxSearchResults
    switch (source) {
      case 'vndb':
        return this.#parse(
          source,
          await this.#requestJson(source, createVndbSearchRequest(query, limit)),
          parseVndbSearchResponse,
        )
      case 'bangumi':
        return this.#parse(
          source,
          await this.#requestJson(source, createBangumiSearchRequest(query, limit)),
          parseBangumiSearchResponse,
        )
      case 'nextmoe':
        return this.#parse(
          source,
          await this.#requestJson(source, createNextMoeWorksRequest(query, limit)),
          parseNextMoeWorksResponse,
        )
      case 'steam':
        return this.#searchSteam(query, limit)
    }
  }

  /**
   * 列出 NextMoe 某部作品的封面，最多 POSTER_LIMITS.maxWorkCovers 张。
   *
   * @returns 作品在 NextMoe 上已不存在时返回空数组。
   * @throws PosterSearchError 请求失败、来源限流或响应格式不符时 reject。
   */
  async listWorkCovers(work: PosterWorkCandidate): Promise<PosterImageCandidate[]> {
    const request = createNextMoeCoversRequest(work.id, POSTER_LIMITS.maxWorkCovers)
    const response = await this.#send('nextmoe', request)
    if (response.status === HTTP_NOT_FOUND && isNextMoeNotFound(parseJsonBody(response.body))) {
      return []
    }
    return this.#parse('nextmoe', this.#readJson('nextmoe', response), (json) =>
      parseNextMoeCoversResponse(json, work),
    )
  }

  async #searchSteam(keyword: string, limit: number): Promise<PosterImageCandidate[]> {
    const apps = this.#parse(
      'steam',
      await this.#requestJson('steam', createSteamSearchRequest(keyword)),
      (json) => parseSteamSearchResponse(json, limit),
    )
    if (apps.length === 0) {
      return []
    }
    return this.#parse(
      'steam',
      await this.#requestJson('steam', createSteamAssetsRequest(apps)),
      (json) => parseSteamAssetsResponse(json, apps),
    )
  }

  async #requestJson(source: PosterSource, request: PosterHttpRequest): Promise<unknown> {
    return this.#readJson(source, await this.#send(source, request))
  }

  async #send(source: PosterSource, request: PosterHttpRequest): Promise<PosterHttpResponse> {
    await this.#waitTurn(source)
    try {
      return await this.#execute(request)
    } catch (cause) {
      throw new PosterSearchError(source, 'network', `${source} request failed`, { cause })
    }
  }

  #readJson(source: PosterSource, response: PosterHttpResponse): unknown {
    const json = parseJsonBody(response.body)
    if (
      response.status === HTTP_TOO_MANY_REQUESTS ||
      (source === 'nextmoe' && isNextMoeRateLimited(json))
    ) {
      throw new PosterSearchError(source, 'rate-limited', `${source} rate limited`)
    }
    if (!isSuccess(response.status)) {
      throw new PosterSearchError(
        source,
        'service-error',
        `${source} returned HTTP ${response.status}`,
      )
    }
    return json
  }

  #parse<TValue>(
    source: PosterSource,
    json: unknown,
    parse: (json: unknown) => TValue | null,
  ): TValue {
    const value = parse(json)
    if (value === null) {
      throw new PosterSearchError(
        source,
        'bad-response',
        `${source} returned an unexpected response`,
      )
    }
    return value
  }

  async #waitTurn(source: PosterSource): Promise<void> {
    const interval = POSTER_REQUEST_INTERVALS_MS[source]
    if (interval === undefined) {
      return
    }
    // 先占下一个时间槽再等待，同一来源并发的请求也会按间隔依次发出。
    const now = this.#clock.now()
    const startAt = Math.max(now, this.#nextRequestAt.get(source) ?? now)
    this.#nextRequestAt.set(source, startAt + interval)
    if (startAt > now) {
      await this.#clock.wait(startAt - now)
    }
  }
}
