import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { POSTER_LIMITS, isOpaqueId, isPosterHash } from '@savedata-sync/shared'
import type { LibraryGame, PosterImageData } from '@savedata-sync/shared'
import { HttpOperationError } from './http-errors.ts'

const POSTER_EXTENSION = '.webp'

/** 本机选图对话框允许的扩展名和对应的 MIME 类型。 */
const PICKED_IMAGE_TYPES: Readonly<Record<string, string>> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

function isWebp(data: Buffer): boolean {
  return (
    data.length >= 12 &&
    data.toString('latin1', 0, 4) === 'RIFF' &&
    data.toString('latin1', 8, 12) === 'WEBP'
  )
}

function posterFileName(gameId: string, posterHash: string): string {
  return `${gameId}.${posterHash}${POSTER_EXTENSION}`
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/** 游戏封面文件，存在一个目录里，文件名是 `<游戏 ID>.<posterHash>.webp`。 */
export class PosterStore {
  readonly #directory: string

  /** @param directory 存放封面的目录，不存在时 prune 和 save 会创建。 */
  constructor(directory: string) {
    this.#directory = directory
  }

  /**
   * 删除 games 没有引用的封面文件和其他残留文件；子目录不动。
   *
   * @throws Error 目录建不了或列不出来时 reject；单个文件删不掉时只写 stderr。
   */
  async prune(games: readonly LibraryGame[]): Promise<void> {
    await mkdir(this.#directory, { recursive: true })
    const kept = new Set(
      games.flatMap((game) =>
        game.posterHash === undefined ? [] : [posterFileName(game.id, game.posterHash)],
      ),
    )
    for (const entry of await readdir(this.#directory, { withFileTypes: true })) {
      if (!entry.isFile() || kept.has(entry.name)) {
        continue
      }
      try {
        await rm(join(this.#directory, entry.name), { force: true })
      } catch (error) {
        // 留下的文件不影响使用，下次启动再删。
        console.error('Failed to delete an unused poster file', error)
      }
    }
  }

  /**
   * 保存一个游戏的封面；同样内容的文件已存在时覆盖。
   *
   * @param data base64 编码的 WebP。
   * @returns 文件内容的 SHA-256，64 位小写十六进制。
   * @throws HttpOperationError gameId 格式不对或内容不是 WebP 时 code 为 invalid-request；
   *   超过 POSTER_LIMITS.maxSavedBytes 时为 resource-limit；写入失败时为 io-failure。
   */
  async save(gameId: string, data: string): Promise<string> {
    const content = Buffer.from(data, 'base64')
    if (!isOpaqueId(gameId) || !isWebp(content)) {
      throw new HttpOperationError('invalid-request', 'The poster must be a WebP image.')
    }
    if (content.length > POSTER_LIMITS.maxSavedBytes) {
      throw new HttpOperationError('resource-limit', 'The poster file is too large.')
    }
    const posterHash = createHash('sha256').update(content).digest('hex')
    const target = join(this.#directory, posterFileName(gameId, posterHash))
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      await mkdir(this.#directory, { recursive: true })
      await writeFile(temporary, content, { flag: 'wx' })
      await rename(temporary, target)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw new HttpOperationError('io-failure', 'Failed to save the poster.', error)
    }
    return posterHash
  }

  /**
   * 读出一个游戏的封面。
   *
   * @returns base64 编码的 WebP。
   * @throws HttpOperationError 参数格式不对时 code 为 invalid-request；文件不存在时为 not-found；
   *   读取失败时为 io-failure。
   */
  async read(gameId: string, posterHash: string): Promise<string> {
    if (!isOpaqueId(gameId) || !isPosterHash(posterHash)) {
      throw new HttpOperationError('invalid-request', 'The poster parameters are invalid.')
    }
    try {
      const content = await readFile(join(this.#directory, posterFileName(gameId, posterHash)))
      return content.toString('base64')
    } catch (error) {
      if (isMissing(error)) {
        throw new HttpOperationError('not-found', 'The poster file does not exist.', error)
      }
      throw new HttpOperationError('io-failure', 'Failed to read the poster.', error)
    }
  }
}

/**
 * 读取用户在选图对话框里选中的图片。
 *
 * @throws HttpOperationError 扩展名不是 JPEG、PNG、WebP 或 GIF 时 code 为 invalid-request；
 *   文件为空时也是 invalid-request；超过 POSTER_LIMITS.maxImageBytes 时为 resource-limit；不存在时为 not-found；
 *   读取失败时为 io-failure。
 */
export async function readPickedImage(path: string): Promise<PosterImageData> {
  const mimeType = PICKED_IMAGE_TYPES[extname(path).toLowerCase()]
  if (mimeType === undefined) {
    throw new HttpOperationError('invalid-request', 'The selected file is not a supported image.')
  }
  try {
    if ((await stat(path)).size > POSTER_LIMITS.maxImageBytes) {
      throw new HttpOperationError('resource-limit', 'The selected image is too large.')
    }
    const content = await readFile(path)
    // stat 和 readFile 之间文件可能被替换成更大的文件。
    if (content.length > POSTER_LIMITS.maxImageBytes) {
      throw new HttpOperationError('resource-limit', 'The selected image is too large.')
    }
    if (content.length === 0) {
      throw new HttpOperationError('invalid-request', 'The selected image is empty.')
    }
    return { mimeType, data: content.toString('base64') }
  } catch (error) {
    if (error instanceof HttpOperationError) {
      throw error
    }
    if (isMissing(error)) {
      throw new HttpOperationError('not-found', 'The selected image does not exist.', error)
    }
    throw new HttpOperationError('io-failure', 'Failed to read the selected image.', error)
  }
}
