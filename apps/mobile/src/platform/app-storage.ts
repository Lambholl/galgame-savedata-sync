import { Capacitor, registerPlugin } from '@capacitor/core'

/** 应用配置存储的原生插件，只接受登记过的键。 */
interface AppStoragePlugin {
  read(options: { key: string }): Promise<{ value: string | null }>
  write(options: { key: string; value: string }): Promise<void>
}

/** 需要原生保存的键；与 AppStoragePlugin.java 的登记表一致。 */
const KEYS = ['savedata-sync:library:1'] as const

const NATIVE =
  Capacitor.getPlatform() === 'android' ? registerPlugin<AppStoragePlugin>('AppStorage') : null
const cache = new Map<string, string>()

/** 把已保存的配置读进内存；读取失败时 reject。 */
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

/** 同步读写的配置存储：读内存，写入内存后按顺序保存；没有原生插件时使用 localStorage。 */
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
