import { useSyncExternalStore } from 'react'

const SYSTEM_DARK_MODE = window.matchMedia('(prefers-color-scheme: dark)')

function subscribe(onChange: () => void): () => void {
  SYSTEM_DARK_MODE.addEventListener('change', onChange)
  return () => SYSTEM_DARK_MODE.removeEventListener('change', onChange)
}

/** 首次渲染即读取系统主题；切换时刷新，组件卸载时释放订阅。 */
export function useSystemDarkMode(): boolean {
  return useSyncExternalStore(subscribe, () => SYSTEM_DARK_MODE.matches)
}
