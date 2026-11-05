import { PublicationError } from './publication-errors.ts'

// 批量传输、复制任务和本机恢复共用的进程名额，从准备、写入一直占到清理结束。
let owner: symbol | null = null

/** 是否有任务占着名额。查询不占名额；任务接受时必须同步 acquire，不能先 await 再登记。 */
export function hasTargetOperation(): boolean {
  return owner !== null
}

/** token 是否持有名额。编排器持有全任务名额时，把同一 token 借给写入器；检查不转移释放责任。 */
export function ownsTargetOperation(token: symbol): boolean {
  return owner === token
}

/** 领取名额，token 只由主进程的编排器持有；重复领取和其他任务都返回 busy。 */
export function acquireTargetOperation(token: symbol): void {
  if (owner !== null) {
    throw new PublicationError('busy', 'Transfer, restore, or file resources are awaiting cleanup.')
  }
  owner = token
}

/** 清理完成后释放名额；过期的 token 不影响后来的任务。 */
export function releaseTargetOperation(token: symbol): void {
  if (owner === token) {
    owner = null
  }
}
