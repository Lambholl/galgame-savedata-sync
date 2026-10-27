import { randomInt, randomUUID } from 'node:crypto'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'

/** 监听端口保存在应用私有目录；首次启动和手动随机时使用高位端口。 */
export class ServicePortSettings {
  private port = 0

  constructor(private readonly file: string) {}

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
        throw new Error('本机服务端口配置无效。')
      }
      this.port = value.port
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw error
      }
      await this.randomize()
    }
  }

  getPort(): number {
    return this.port
  }

  async save(port: number): Promise<void> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('端口应为 1 到 65535 的整数。')
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

  async randomize(): Promise<void> {
    let port: number
    do {
      port = randomInt(49152, 65536)
    } while (port === this.port)
    await this.save(port)
  }
}
