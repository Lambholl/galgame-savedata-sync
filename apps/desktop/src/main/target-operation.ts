import { PublicationError } from './publication-errors.ts'

// 旧批次、新复制与本机恢复共用进程名额，覆盖准备、写入及未完成清理。
let owner: symbol | null = null

/** 查询不占名额；接纳任务须同步 acquire，不能先 await 再登记。 */
export function hasTargetOperation(): boolean {
  return owner !== null
}

/** 仅原生编排持有 token；重复接纳和其他任务均返回 busy。 */
export function acquireTargetOperation(token: symbol): void {
  if (owner !== null) {
    throw new PublicationError('busy', '已有传输、恢复或文件资源等待清理。')
  }
  owner = token
}

/** 清理确已完成后释放；旧 token 不影响新任务。 */
export function releaseTargetOperation(token: symbol): void {
  if (owner === token) {
    owner = null
  }
}
