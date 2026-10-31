import { Capacitor, registerPlugin } from '@capacitor/core'

/** 原生插件把应用配置存在应用私有 SharedPreferences，只接受登记过的键。 */
interface AppStoragePlugin {
  read(options: { key: string }): Promise<{ value: string | null }>
  write(options: { key: string; value: string }): Promise<void>
}

/** 需要原生保存的键；与 AppStoragePlugin.java 的登记表一致。 */
const KEYS = ['savedata-sync:library:1'] as const

const NATIVE =
  Capacitor.getPlatform() === 'android' ? registerPlugin<AppStoragePlugin>('AppStorage') : null
const cache = new Map<string, string>()

/**
 * 首次渲染前把配置读进内存。开发阶段不迁移旧版存在 WebView localStorage 的配置（用户 2026-11-01 确认）。
 * 读取失败时抛出，避免以空配置启动后覆盖原生已保存的数据。
 */
export async function loadAppStorage(): Promise<void> {
  if (!NATIVE) {
    return
  }
  for (const key of KEYS) {
    const { value } = await NATIVE.read({ key })
    if (value !== null) {
      cache.set(key, value)
    }
  }
}

/**
 * 同步读写接口，供游戏库适配器使用：读内存，写入内存后按顺序交给原生保存。
 * 浏览器预览没有原生插件，直接使用 localStorage。
 */
export const appStorage: Pick<Storage, 'getItem' | 'setItem'> = {
  getItem(key) {
    return NATIVE ? (cache.get(key) ?? null) : localStorage.getItem(key)
  },
  setItem(key, value) {
    if (!NATIVE) {
      localStorage.setItem(key, value)
      return
    }
    cache.set(key, value)
    NATIVE.write({ key, value }).catch((error: unknown) => {
      console.error('Failed to save native app storage', key, error)
    })
  },
}
