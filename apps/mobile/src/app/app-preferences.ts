import { useSyncExternalStore } from 'react'
import { DEFAULT_APP_PREFERENCES, parseAppPreferences } from '@savedata-sync/shared'
import type { AppPreferences } from '@savedata-sync/shared'

const STORAGE_KEY = 'savedata-sync.preferences'
const listeners = new Set<() => void>()

function load(): AppPreferences {
  try {
    const text = localStorage.getItem(STORAGE_KEY)
    return text === null ? DEFAULT_APP_PREFERENCES : parseAppPreferences(JSON.parse(text))
  } catch (error) {
    console.error('Failed to read app preferences, using defaults', error)
    return DEFAULT_APP_PREFERENCES
  }
}

let current = load()

/** 当前界面偏好（主题、语言），保存在本机 WebView 存储。 */
export function getAppPreferences(): AppPreferences {
  return current
}

/** 立即生效并保存；存储不可用时本次运行仍按新偏好显示。 */
export function setAppPreferences(next: AppPreferences): void {
  current = next
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch (error) {
    console.error('Failed to save app preferences', error)
  }
  for (const listener of listeners) {
    listener()
  }
}

/** 供 useSyncExternalStore 与主题同步订阅；返回取消订阅函数。 */
export function subscribeAppPreferences(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 在组件中读取当前偏好，偏好变化时重新渲染。 */
export function useAppPreferences(): AppPreferences {
  return useSyncExternalStore(subscribeAppPreferences, getAppPreferences)
}
