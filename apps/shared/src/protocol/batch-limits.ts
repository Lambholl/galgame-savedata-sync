import type { BatchLimits } from './batch-contracts.ts'

/** v1 首轮固定预算；修改须同步双端、守卫、设计和边界测试。 */
export const BATCH_LIMITS = Object.freeze({
  maxFiles: 1024,
  maxFileBytes: 268435456,
  maxTotalFileBytes: 1073741824,
  maxTarBytes: 1074790400,
  maxArchiveBytes: 1140850688,
  maxJsonBytes: 8388608,
  maxConcurrentBatches: 1,
  maxTransfersPerSession: 4096,
} as const satisfies BatchLimits)

/** 显式应用 IO 缓冲与每端私有缓存预算，不代表整个运行时的峰值内存。 */
export const BATCH_RESOURCES = Object.freeze({
  maxBufferBytes: 65536,
  maxCacheBytes: 3221225472,
} as const)

/** 期限从任务接纳/阶段进入/网络进展计算，轮询不得延长；实际执行由平台负责。 */
export const BATCH_TIMEOUTS_MS = Object.freeze({
  ready: 600000,
  awaitingContent: 120000,
  total: 1800000,
  networkIdle: 60000,
  terminalRetention: 600000,
} as const)

/** 受限归档固定参数；成员只能为连续 fileId，不携带用户路径。 */
export const BATCH_ARCHIVE = Object.freeze({
  format: 'tar.gz',
  compressionLevel: 1,
  tarBlockBytes: 512,
  tarEndBytes: 1024,
  contentType: 'application/gzip',
} as const)

/** 批内索引严格为 f000001–f001024；不接受源名称、路径或零号。 */
export function isBatchFileId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length === 7 &&
    /^f\d{6}$/.test(value) &&
    Number(value.slice(1)) >= 1 &&
    Number(value.slice(1)) <= BATCH_LIMITS.maxFiles
  )
}
