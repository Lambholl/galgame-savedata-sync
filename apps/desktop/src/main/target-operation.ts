import { PublicationError } from './publication-errors.ts'

// 批量传输、复制任务和本机恢复共用的进程名额，从准备、写入一直占到清理结束。
let owner: symbol | null = null

// 任务接受时要同步 acquire，先 await 再登记会让两个任务都看到名额空闲。
/** 判断是否有任务占着写入名额。 */
export function hasTargetOperation(): boolean {
  return owner !== null
}

/** 判断 token 是否持有写入名额。 */
export function ownsTargetOperation(token: symbol): boolean {
  return owner === token
}

/** 用 token 领取写入名额；名额已被占用（包括同一 token）时抛出 busy 错误。 */
export function acquireTargetOperation(token: symbol): void {
  if (owner !== null) {
    throw new PublicationError('busy', 'Transfer, restore, or file resources are awaiting cleanup.')
  }
  owner = token
}

/** 释放 token 持有的写入名额；token 已不持有名额时不做任何事。 */
export function releaseTargetOperation(token: symbol): void {
  if (owner === token) {
    owner = null
  }
}
