import { OperationFailure } from '../result.ts'
import type { LibraryGame } from '../library/library.ts'
import type { PeerPoster } from './poster-contracts.ts'

/** 导入成功后要写进本机游戏的封面字段。 */
export type ImportedPoster = Required<Pick<LibraryGame, 'posterHash'>> &
  Pick<LibraryGame, 'posterSource'>

/**
 * 取对端游戏的封面并存成本机游戏的封面。
 *
 * @param expectedHash 对端目录表里这个游戏的 posterHash。
 * @param read 向对端请求封面。
 * @param save 保存 base64 WebP 并返回文件内容的 posterHash，同 PosterAdapter.save。
 * @returns 要写进本机游戏的 posterHash 和 posterSource；对端没有记录出处时不带 posterSource。
 * @throws OperationFailure 对端答复的 hash 或保存后算出的 hash 与 expectedHash 不同时 code 为 invalid-request；
 *   read 和 save 的错误原样抛出。
 */
export async function importPeerPoster(
  gameId: string,
  expectedHash: string,
  read: () => Promise<PeerPoster>,
  save: (gameId: string, data: string) => Promise<string>,
): Promise<ImportedPoster> {
  const poster = await read()
  if (poster.hash !== expectedHash) {
    throw new OperationFailure('invalid-request', 'The peer poster changed. Import it again.')
  }
  // 对端答复的 hash 只是它自己报的值；按保存时算出的 hash 核对内容确实是目录表里那张图。
  const posterHash = await save(gameId, poster.data)
  if (posterHash !== expectedHash) {
    throw new OperationFailure('invalid-request', 'The peer poster content does not match.')
  }
  return poster.source === null ? { posterHash } : { posterHash, posterSource: poster.source }
}
