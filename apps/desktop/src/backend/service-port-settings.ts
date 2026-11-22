import { randomInt, randomUUID } from 'node:crypto'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'

/** 监听端口的设置。 */
export class ServicePortSettings {
  private port = 0

  constructor(private readonly file: string) {}

  /** 读取端口；文件不存在时随机选一个高位端口并保存，内容无效时抛错。 */
  async load(): Promise<void> {
    try {
      const value: unknown = JSON.parse(await readFile(this.file, 'utf8'))
      if (
        typeof value !== 'object' ||
        value === null ||
        !('port' in value) ||
        typeof value.port !== 'number' ||
        !Number.isInteger(value.port) ||
        value.port < 1 ||
        value.port > 65535
      ) {
        throw new Error('The local service port configuration is invalid.')
      }
      this.port = value.port
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw error
      }
      await this.randomize()
    }
  }

  /** 返回当前端口。 */
  getPort(): number {
    return this.port
  }

  /** 保存端口；port 不是 1 到 65535 的整数时抛错。写入成功后 getPort 才返回新值。 */
  async save(port: number): Promise<void> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('The port must be an integer from 1 to 65535.')
    }
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify({ port }), { encoding: 'utf8', flag: 'wx' })
      await rename(temporary, this.file)
      this.port = port
    } catch (error) {
      await unlink(temporary).catch(() => {})
      throw error
    }
  }

  /** 随机选一个与当前不同的高位端口（49152 到 65535）并保存。 */
  async randomize(): Promise<void> {
    let port: number
    do {
      port = randomInt(49152, 65536)
    } while (port === this.port)
    await this.save(port)
  }
}
