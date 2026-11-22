import type { OperationResult } from '@savedata-sync/shared'

/** 通道处理函数：参数是界面传来的原始参数，返回值原样回给界面。 */
export type ChannelHandler = (...args: unknown[]) => unknown

/** 按通道名登记处理函数的注册表。 */
export interface ChannelRegistry {
  /** 登记通道的处理函数；同名通道已登记时抛 Error。 */
  handle(channel: string, handler: ChannelHandler): void
  /** 撤销通道的处理函数；没登记过时什么也不做。 */
  removeHandler(channel: string): void
}

const UNKNOWN_CHANNEL: OperationResult<never> = {
  status: 'error',
  error: {
    code: 'invalid-request',
    message: 'The requested channel does not exist.',
    canRetry: false,
  },
}

/** 后端的通道注册表；调用方是否可信由宿主在 invoke 之前判断。 */
export class ChannelRouter implements ChannelRegistry {
  readonly #handlers = new Map<string, ChannelHandler>()

  handle(channel: string, handler: ChannelHandler): void {
    if (this.#handlers.has(channel)) {
      throw new Error(`Channel ${channel} is already registered.`)
    }
    this.#handlers.set(channel, handler)
  }

  removeHandler(channel: string): void {
    this.#handlers.delete(channel)
  }

  /**
   * 调用通道的处理函数。
   *
   * @returns 处理函数的返回值；通道没有登记时返回 invalid-request 错误结果。
   *   处理函数抛出的异常原样 reject。
   */
  async invoke(channel: string, args: readonly unknown[]): Promise<unknown> {
    const handler = this.#handlers.get(channel)
    return handler ? await handler(...args) : UNKNOWN_CHANNEL
  }
}
