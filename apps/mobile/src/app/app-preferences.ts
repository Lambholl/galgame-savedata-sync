import { useSyncExternalStore } from 'react'
import { Capacitor, registerPlugin } from '@capacitor/core'
import { DEFAULT_APP_PREFERENCES, isAppPreferences } from '@savedata-sync/shared'
import type { AppPreferences } from '@savedata-sync/shared'

/** 原生插件把偏好存在应用私有 SharedPreferences，并按主题切换夜间模式。 */
interface AppPreferencesPlugin {
  read(): Promise<unknown>
  write(options: { theme: string; locale: string }): Promise<unknown>
}

const NATIVE =
  Capacitor.getPlatform() === 'android'
    ? registerPlugin<AppPreferencesPlugin>('AppPreferences')
    : null
const listeners = new Set<() => void>()
let current = DEFAULT_APP_PREFERENCES

function publish(next: AppPreferences): void {
  current = next
  for (const listener of listeners) {
    listener()
  }
}

/** 读取已保存的偏好；读取失败时用默认值。没有原生插件时，偏好只在本次运行内有效。 */
export async function loadAppPreferences(): Promise<void> {
  if (!NATIVE) {
    return
  }
  try {
    const value = await NATIVE.read()
    if (isAppPreferences(value)) {
      publish(value)
    }
  } catch (error) {
    console.error('Failed to read app preferences, using defaults', error)
  }
}

/** 当前界面偏好（主题、语言）。 */
export function getAppPreferences(): AppPreferences {
  return current
}

/** 立即生效并保存；保存失败时恢复原值并抛错。 */
export async function setAppPreferences(next: AppPreferences): Promise<void> {
  const previous = current
  publish(next)
  if (!NATIVE) {
    return
  }
  try {
    await NATIVE.write({ theme: next.theme, locale: next.locale })
  } catch (error) {
    publish(previous)
    throw error
  }
}

/** 订阅偏好变化；返回取消订阅的函数。 */
export function subscribeAppPreferences(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 在组件中读取当前偏好，偏好变化时重新渲染。 */
export function useAppPreferences(): AppPreferences {
  return useSyncExternalStore(subscribeAppPreferences, getAppPreferences)
}
