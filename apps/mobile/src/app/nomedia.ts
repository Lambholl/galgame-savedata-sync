import { useSyncExternalStore } from 'react'
import type { LibraryGame } from '@savedata-sync/shared'
import { androidDirectories } from '../platform/directories'
import { readNomediaSetting, writeNomediaSetting } from './app-preferences'

/** 自动添加 .nomedia 的开关和本次运行里的添加结果。 */
export interface NomediaState {
  readonly shouldAddNomedia: boolean
  /** 最近一次没能添加 .nomedia 的游戏 ID；之后添加成功或关闭开关时移除。只保存在内存里。 */
  readonly failedGameIds: readonly string[]
}

const listeners = new Set<() => void>()
let current: NomediaState = { shouldAddNomedia: false, failedGameIds: [] }
// 各次添加依次进行，前一批的结果写完后才处理下一批，失败列表不会互相覆盖。
let queue = Promise.resolve()

function publish(next: NomediaState): void {
  current = next
  for (const listener of listeners) {
    listener()
  }
}

async function addEach(games: readonly LibraryGame[]): Promise<void> {
  for (const game of games) {
    if (!current.shouldAddNomedia) {
      return
    }
    if (game.rootId === null) {
      continue
    }
    const result = await androidDirectories.addNomedia(game.rootId)
    if (result.status === 'error') {
      console.error('Failed to add .nomedia', game.id, result.error.code)
    }
    const others = current.failedGameIds.filter((id) => id !== game.id)
    publish({
      ...current,
      failedGameIds:
        result.status === 'success' || !current.shouldAddNomedia ? others : [...others, game.id],
    })
  }
}

/** 读取已保存的开关；读取失败时按关闭处理。 */
export async function loadNomediaSetting(): Promise<void> {
  try {
    publish({ ...current, shouldAddNomedia: await readNomediaSetting() })
  } catch (error) {
    console.error('Failed to read the .nomedia setting, using off', error)
  }
}

/**
 * 开关开着时，依次在这些游戏的存档目录根下补上 .nomedia；没有本机目录的游戏跳过。
 * 添加失败的游戏记入 failedGameIds，成功的移出。立即返回，不等添加完成。
 */
export function addNomedia(games: readonly LibraryGame[]): void {
  queue = queue
    .then(() => addEach(games))
    .catch((error: unknown) => {
      console.error('Failed to add .nomedia', error)
    })
}

/**
 * 立即改变并保存开关；打开时为 games 里的全部游戏补上 .nomedia，关闭时清空 failedGameIds。
 *
 * @throws Error 保存失败；开关恢复原值。
 */
export async function setNomediaSetting(
  shouldAddNomedia: boolean,
  games: readonly LibraryGame[],
): Promise<void> {
  const previous = current
  publish({
    shouldAddNomedia,
    failedGameIds: shouldAddNomedia ? current.failedGameIds : [],
  })
  try {
    await writeNomediaSetting(shouldAddNomedia)
  } catch (error) {
    publish(previous)
    throw error
  }
  if (shouldAddNomedia) {
    addNomedia(games)
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 在组件中读取开关和添加结果，变化时重新渲染。 */
export function useNomedia(): NomediaState {
  return useSyncExternalStore(subscribe, () => current)
}
