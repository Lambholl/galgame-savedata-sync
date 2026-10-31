import type { SyncEntry, SyncSnapshot } from './sync-contracts.ts'
import { syncPathKey } from './sync-paths.ts'

/** 两端位置固定：左边电脑，右边手机，与传输方向无关。 */
export type CompareSide = 'pc' | 'phone'

/** 显示用的条目类型；图片指 png/jpg/jpeg/bmp/webp/gif。 */
export type FileKind = 'directory' | 'image' | 'file'

/**
 * 条目相对另一端的状态：
 * same 两端相同；differs 两端都有但内容（或类型）不同，或内容未能读取；
 * only 只在这一端有；contains-differences 两端都有的文件夹，里面有不一致的文件。
 */
export type CompareState = 'same' | 'differs' | 'only' | 'contains-differences'

export interface CompareItem {
  readonly path: readonly string[]
  readonly name: string
  readonly kind: FileKind
  readonly sizeBytes: number | null
  readonly modifiedAt: number | null
  readonly state: CompareState
  /** 文件夹里不一致的文件数（含子文件夹，两端合计按路径去重）；文件为 0。 */
  readonly differingCount: number
}

export interface SnapshotComparison {
  /** 两端都有、内容不同的文件数。 */
  readonly differingFiles: number
  /** 只在一端有的文件数（两端合计）。 */
  readonly onlyFiles: number
  readonly children: ReadonlyMap<string, readonly CompareItem[]>
}

const IMAGE = /\.(?:png|jpe?g|bmp|webp|gif)$/i
const COLLATOR = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

export function fileKindOf(name: string, kind: SyncEntry['kind']): FileKind {
  if (kind === 'directory') {
    return 'directory'
  }
  return IMAGE.test(name) ? 'image' : 'file'
}

function childrenKey(side: CompareSide, parent: readonly string[]): string {
  return `${side}:${syncPathKey(parent)}`
}

function isSameFile(left: SyncEntry, right: SyncEntry): boolean {
  return (
    left.kind === 'file' &&
    right.kind === 'file' &&
    left.sha256 !== null &&
    left.sha256 === right.sha256 &&
    left.sizeBytes === right.sizeBytes
  )
}

/** 文件夹在前，其余按名称的自然顺序（数字按数值）排列。 */
function compareItems(left: CompareItem, right: CompareItem): number {
  const isLeftDirectory = left.kind === 'directory'
  if (isLeftDirectory !== (right.kind === 'directory')) {
    return isLeftDirectory ? -1 : 1
  }
  return COLLATOR.compare(left.name, right.name) || (left.name < right.name ? -1 : 1)
}

/**
 * 比较两端本次扫描的完整快照，生成每一层的显示列表。
 * 路径按原始名称精确匹配（与传输计划一致）；内容以 SHA-256 与大小判断，任一端哈希未知视为不同。
 */
export function compareSnapshots(pc: SyncSnapshot, phone: SyncSnapshot): SnapshotComparison {
  const sides: Record<CompareSide, Map<string, SyncEntry>> = {
    pc: new Map(pc.entries.map((entry) => [syncPathKey(entry.path), entry])),
    phone: new Map(phone.entries.map((entry) => [syncPathKey(entry.path), entry])),
  }
  // 先找出所有不一致的文件路径，再给它们的每一级上级文件夹计数。
  const differing = new Map<string, readonly string[]>()
  let differingFiles = 0
  let onlyFiles = 0
  for (const [side, other] of [
    ['pc', 'phone'],
    ['phone', 'pc'],
  ] as const) {
    for (const [key, entry] of sides[side]) {
      if (entry.kind !== 'file' || differing.has(key)) {
        continue
      }
      const counterpart = sides[other].get(key)
      if (!counterpart) {
        onlyFiles++
        differing.set(key, entry.path)
      } else if (!isSameFile(entry, counterpart)) {
        differingFiles++
        differing.set(key, entry.path)
      }
    }
  }
  const counts = new Map<string, number>()
  for (const path of differing.values()) {
    for (let length = 1; length < path.length; length++) {
      const key = syncPathKey(path.slice(0, length))
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  const children = new Map<string, CompareItem[]>()
  for (const [side, other] of [
    ['pc', 'phone'],
    ['phone', 'pc'],
  ] as const) {
    for (const [key, entry] of sides[side]) {
      const name = entry.path[entry.path.length - 1] ?? ''
      const counterpart = sides[other].get(key)
      const differingCount = entry.kind === 'directory' ? (counts.get(key) ?? 0) : 0
      let state: CompareState
      if (!counterpart) {
        state = 'only'
      } else if (entry.kind !== counterpart.kind) {
        state = 'differs'
      } else if (entry.kind === 'directory') {
        state = differingCount > 0 ? 'contains-differences' : 'same'
      } else {
        state = isSameFile(entry, counterpart) ? 'same' : 'differs'
      }
      const listKey = childrenKey(side, entry.path.slice(0, -1))
      const list = children.get(listKey) ?? []
      list.push({
        path: entry.path,
        name,
        kind: fileKindOf(name, entry.kind),
        sizeBytes: entry.kind === 'directory' ? null : entry.sizeBytes,
        modifiedAt: entry.modifiedAt,
        state,
        differingCount,
      })
      children.set(listKey, list)
    }
  }
  for (const list of children.values()) {
    list.sort(compareItems)
  }
  return { differingFiles, onlyFiles, children }
}

/** 某一端某一层的条目，文件夹在前；层不存在时返回空列表。 */
export function comparisonChildren(
  comparison: SnapshotComparison,
  side: CompareSide,
  parent: readonly string[],
): readonly CompareItem[] {
  return comparison.children.get(childrenKey(side, parent)) ?? []
}
