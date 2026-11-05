import type { BatchLimits } from './batch-contracts.ts'

/** 批量传输 v1 的固定上限；修改时要同步两端、校验函数、设计文档和边界测试。 */
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

/** 应用显式使用的 IO 缓冲和每端私有缓存上限，不代表整个运行时的峰值内存。 */
export const BATCH_RESOURCES = Object.freeze({
  maxBufferBytes: 65536,
  maxCacheBytes: 3221225472,
} as const)

/** 批量任务的期限，从任务接受、进入阶段和网络进展分别计算，轮询不能延长；由平台执行。 */
export const BATCH_TIMEOUTS_MS = Object.freeze({
  ready: 600000,
  awaitingContent: 120000,
  total: 1800000,
  networkIdle: 60000,
  terminalRetention: 600000,
} as const)

/** 归档的固定参数；成员名只能是连续的 fileId，不含用户路径。 */
export const BATCH_ARCHIVE = Object.freeze({
  format: 'tar.gz',
  compressionLevel: 1,
  tarBlockBytes: 512,
  tarEndBytes: 1024,
  contentType: 'application/gzip',
} as const)

/** 校验批内索引：严格为 f000001 到 f001024。 */
export function isBatchFileId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length === 7 &&
    /^f\d{6}$/.test(value) &&
    Number(value.slice(1)) >= 1 &&
    Number(value.slice(1)) <= BATCH_LIMITS.maxFiles
  )
}
