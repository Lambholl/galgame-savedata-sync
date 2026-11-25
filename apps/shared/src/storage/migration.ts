/** 把版本 n 的数据变成版本 n+1，只操作已解析的 JSON，不读写文件；输入不合格式时抛错。 */
export type MigrationStep = (value: Readonly<Record<string, unknown>>) => unknown

/** 一种带 schemaVersion 的结构化数据的迁移链。 */
export interface MigrationChain {
  /** 1.0 写入的格式版本；更低的版本属于 0.x，按读不懂处理。 */
  readonly baseVersion: number
  /** 当前格式版本。 */
  readonly currentVersion: number
  /** 键是起始版本 n，从 baseVersion 到 currentVersion - 1 各有一步，把版本 n 的数据变成 n+1。 */
  readonly steps: Readonly<Record<number, MigrationStep>>
}

/**
 * current：已是当前版本；migrated：从 fromVersion 迁移到了当前版本，value 是要写回的内容；
 * newer：由更新版本写入；unreadable：读不懂，包括低于基线的版本和迁移失败。
 */
export type MigrationResult =
  | { readonly status: 'current'; readonly value: unknown }
  | { readonly status: 'migrated'; readonly value: unknown; readonly fromVersion: number }
  | { readonly status: 'newer' }
  | { readonly status: 'unreadable' }

function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 按 schemaVersion 把已解析的数据迁移到 chain 的当前版本，迁移后的内容要通过 isValid。不修改 value。
 * 不是 JSON 对象或 schemaVersion 不是整数时为 unreadable。
 */
export function migrateData(
  value: unknown,
  chain: MigrationChain,
  isValid: (value: unknown) => boolean,
): MigrationResult {
  const version = isJsonObject(value) ? value.schemaVersion : undefined
  if (!isJsonObject(value) || typeof version !== 'number' || !Number.isSafeInteger(version)) {
    return { status: 'unreadable' }
  }
  if (version > chain.currentVersion) {
    return { status: 'newer' }
  }
  if (version === chain.currentVersion) {
    return isValid(value) ? { status: 'current', value } : { status: 'unreadable' }
  }
  if (version < chain.baseVersion) {
    return { status: 'unreadable' }
  }
  let current: unknown = value
  for (let from = version; from < chain.currentVersion; from++) {
    const step = chain.steps[from]
    if (!step || !isJsonObject(current)) {
      return { status: 'unreadable' }
    }
    try {
      current = step(current)
    } catch {
      // 步骤只在数据不合它认的旧格式时抛错，这份数据和损坏的数据一样处理。
      return { status: 'unreadable' }
    }
    // 每一步都要把版本号加一，否则后面的步骤会拿错格式。
    if (!isJsonObject(current) || current.schemaVersion !== from + 1) {
      return { status: 'unreadable' }
    }
  }
  return isValid(current)
    ? { status: 'migrated', value: current, fromVersion: version }
    : { status: 'unreadable' }
}
