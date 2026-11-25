import { useSyncExternalStore } from 'react'
import { readLaunchAnimationSetting, writeLaunchAnimationSetting } from './app-preferences'

const listeners = new Set<() => void>()
let shouldPlayCurrently = true

function publish(shouldPlay: boolean): void {
  shouldPlayCurrently = shouldPlay
  for (const listener of listeners) {
    listener()
  }
}

/** 读取已保存的开屏动画开关；读取失败时按打开处理。 */
export async function loadLaunchAnimationSetting(): Promise<void> {
  try {
    publish(await readLaunchAnimationSetting())
  } catch (error) {
    console.error('Failed to read the launch animation setting, using on', error)
  }
}

/**
 * 立即改变并保存开屏动画开关。
 *
 * @throws Error 保存失败；开关恢复原值。
 */
export async function setLaunchAnimationSetting(shouldPlayLaunchAnimation: boolean): Promise<void> {
  const shouldPlayBefore = shouldPlayCurrently
  publish(shouldPlayLaunchAnimation)
  try {
    await writeLaunchAnimationSetting(shouldPlayLaunchAnimation)
  } catch (error) {
    publish(shouldPlayBefore)
    throw error
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 在组件中读取是否播放开屏动画，变化时重新渲染。 */
export function useLaunchAnimationSetting(): boolean {
  return useSyncExternalStore(subscribe, () => shouldPlayCurrently)
}
