import { Capacitor, registerPlugin } from '@capacitor/core'
import { isDataResetList, isVersionedDataList } from '@savedata-sync/shared'
import type { DataResetItem, VersionedDataItem } from '@savedata-sync/shared'

/** 应用配置存储的原生插件，只接受登记过的键。 */
interface AppStoragePlugin {
  read(options: { key: string }): Promise<{ value: string | null }>
  write(options: { key: string; value: string }): Promise<void>
  dataResets(): Promise<{ items: unknown }>
  newerData(): Promise<{ items: unknown }>
  dismissDataResets(): Promise<void>
}

/** 需要原生保存的键；与 AppStoragePlugin.java 的登记表一致。 */
const KEYS = ['savedata-sync:library:1'] as const

const NATIVE =
  Capacitor.getPlatform() === 'android' ? registerPlugin<AppStoragePlugin>('AppStorage') : null
const cache = new Map<string, string>()
/** 最后一次原生写入；写入串成一条链，后写的值不会被先写的覆盖。 */
let writing: Promise<void> = Promise.resolve()

/** 从原生存储读入已保存的配置，替换内存里的值，可以重复调用；没有原生插件时直接完成，读取失败时 reject。 */
export async function loadAppStorage(): Promise<void> {
  if (!NATIVE) {
    return
  }
  for (const key of KEYS) {
    const { value } = await NATIVE.read({ key })
    if (value === null) {
      cache.delete(key)
    } else {
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
    const native = NATIVE
    writing = writing
      .then(() => native.write({ key, value }))
      .catch((error: unknown) => {
        console.error('Failed to save native app storage', key, error)
      })
  },
}

/** 等到此前 setItem 的值都交给原生存储；写入失败只记日志，不 reject。 */
export function flushAppStorage(): Promise<void> {
  return writing
}

/**
 * 列出这次启动时因读不懂而改用默认值的数据项；dismissDataResets 之后返回空列表，没有原生插件时也返回空列表。
 *
 * @throws Error 原生层返回的内容格式不对时抛出。
 */
export async function readDataResets(): Promise<readonly DataResetItem[]> {
  if (!NATIVE) {
    return []
  }
  const { items } = await NATIVE.dataResets()
  if (!isDataResetList(items)) {
    throw new Error('The native data reset list is invalid.')
  }
  return items
}

/**
 * 列出这次启动时发现的由更新版本的应用写入的数据项；不为空时原生层没有改动任何数据，也没有注册其余插件。
 * 没有原生插件时返回空列表。
 *
 * @throws Error 原生层返回的内容格式不对时抛出。
 */
export async function readNewerData(): Promise<readonly VersionedDataItem[]> {
  if (!NATIVE) {
    return []
  }
  const { items } = await NATIVE.newerData()
  if (!isVersionedDataList(items)) {
    throw new Error('The native newer data list is invalid.')
  }
  return items
}

/** 清空重置项列表；没有原生插件时直接完成。 */
export async function dismissDataResets(): Promise<void> {
  await NATIVE?.dismissDataResets()
}
