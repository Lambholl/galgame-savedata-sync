import { unwrap } from '../result.ts'
import type { OperationResult } from '../protocol/contracts.ts'
import type {
  PosterCandidate,
  PosterClock,
  PosterFileData,
  PosterHttpRequest,
  PosterHttpResponse,
  PosterImageCandidate,
  PosterImageData,
  PosterSaveResult,
  PosterSource,
  PosterWorkCandidate,
} from './poster-contracts.ts'
import { PosterSearchClient } from './poster-search-client.ts'

/** 本机的封面执行器和封面文件接口；所有方法的失败都以错误结果返回。 */
export interface PosterApi {
  /** 执行封面接口请求；连不上返回 network-failure。 */
  request(request: PosterHttpRequest): Promise<OperationResult<PosterHttpResponse>>
  /** 下载候选图片；地址不在图片主机白名单返回 invalid-request。 */
  downloadImage(url: string): Promise<OperationResult<PosterImageData>>
  /** 打开选图界面读取一张图片；取消时 value 为 null，超过大小上限返回 resource-limit。 */
  pickImage(): Promise<OperationResult<PosterImageData | null>>
  /** 保存游戏的封面（base64 编码的封面文件，格式见 PosterFormat），返回要写进游戏库的 posterHash。 */
  save(gameId: string, data: PosterFileData): Promise<OperationResult<PosterSaveResult>>
  /** 读出游戏的封面；文件不存在返回 not-found。 */
  read(gameId: string, posterHash: string): Promise<OperationResult<PosterFileData>>
}

/** 封面搜索、下载和封面文件读写；失败都以 OperationFailure 或 PosterSearchError reject。 */
export interface PosterAdapter {
  /** 同 PosterSearchClient.search。 */
  search(source: PosterSource, keyword: string): Promise<PosterCandidate[]>
  /** 同 PosterSearchClient.listWorkCovers。 */
  listWorkCovers(work: PosterWorkCandidate): Promise<PosterImageCandidate[]>
  /** 下载候选图片；失败时以 OperationFailure reject。 */
  downloadImage(url: string): Promise<PosterImageData>
  /** 打开选图界面读取一张图片；取消时返回 null，失败时以 OperationFailure reject。 */
  pickImage(): Promise<PosterImageData | null>
  /**
   * 保存游戏的封面。
   *
   * @param data base64 编码的封面文件，格式见 PosterFormat。
   * @returns 要写进 LibraryGame.posterHash 的值。
   */
  save(gameId: string, data: string): Promise<string>
  /**
   * 读出游戏的封面。
   *
   * @returns base64 编码的封面文件。
   * @throws OperationFailure 文件不存在时 code 为 not-found。
   */
  read(gameId: string, posterHash: string): Promise<string>
}

/**
 * 创建封面适配器；搜索的限流排队只在同一个适配器内生效，一个应用进程只应创建一个。
 *
 * @param api 每次调用时取接口；它抛出的错误原样作为对应方法的 reject 原因。
 * @param clock 搜索限流排队用的时钟。
 */
export function createPosterAdapter(api: () => PosterApi, clock: PosterClock): PosterAdapter {
  const client = new PosterSearchClient(
    async (request) => unwrap(await api().request(request)),
    clock,
  )
  return {
    search: (source, keyword) => client.search(source, keyword),
    listWorkCovers: (work) => client.listWorkCovers(work),
    async downloadImage(url) {
      return unwrap(await api().downloadImage(url))
    },
    async pickImage() {
      return unwrap(await api().pickImage())
    },
    async save(gameId, data) {
      return unwrap(await api().save(gameId, { data })).posterHash
    },
    async read(gameId, posterHash) {
      return unwrap(await api().read(gameId, posterHash)).data
    },
  }
}
