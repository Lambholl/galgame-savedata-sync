import { useEffect, useRef, useState } from 'react'
import type { LibraryGame } from '../../library/library.ts'
import type { PosterAdapter } from '../../poster/poster-adapter.ts'
import { base64ToBlob } from './poster-image.ts'

function posterKey(gameId: string, posterHash: string): string {
  return `${gameId}/${posterHash}`
}

/**
 * 读出游戏的封面，转成可以给 img 用的 blob 地址。
 *
 * @returns 键是游戏 ID；没有封面、还没读出或读取失败的游戏不在里面。不再需要的地址和组件卸载时的全部地址会被释放。
 */
export function usePosterUrls(
  games: readonly LibraryGame[],
  adapter: Pick<PosterAdapter, 'read'>,
): ReadonlyMap<string, string> {
  // 键是 posterKey，值是 blob 地址；只在 effect 和异步回调里读写，渲染读 loaded。
  const cacheRef = useRef(new Map<string, string>())
  const isDisposedRef = useRef(false)
  const [loaded, setLoaded] = useState<ReadonlyMap<string, string>>(() => new Map())
  const wantedKeys = games.flatMap((game) =>
    game.posterHash ? [posterKey(game.id, game.posterHash)] : [],
  )
  const wantedKey = wantedKeys.join('\n')

  useEffect(() => {
    isDisposedRef.current = false
    const cache = cacheRef.current
    return () => {
      isDisposedRef.current = true
      for (const url of cache.values()) {
        URL.revokeObjectURL(url)
      }
      cache.clear()
    }
  }, [])

  useEffect(() => {
    const cache = cacheRef.current
    const wanted = new Set(wantedKey === '' ? [] : wantedKey.split('\n'))
    // 换了封面或删了游戏的旧地址直接释放；loaded 里的旧值不在 wanted 里，渲染时不会再用到。
    for (const [key, url] of cache) {
      if (!wanted.has(key)) {
        URL.revokeObjectURL(url)
        cache.delete(key)
      }
    }
    for (const key of wanted) {
      if (cache.has(key)) {
        continue
      }
      const separator = key.lastIndexOf('/')
      adapter.read(key.slice(0, separator), key.slice(separator + 1)).then(
        (data) => {
          if (isDisposedRef.current || cache.has(key)) {
            return
          }
          cache.set(key, URL.createObjectURL(base64ToBlob(data, 'image/webp')))
          setLoaded(new Map(cache))
        },
        () => {
          // 读不出的封面显示占位封面，用户重新设置封面后会换成新的 posterHash 再读。
        },
      )
    }
  }, [wantedKey, adapter])

  const result = new Map<string, string>()
  for (const game of games) {
    const url = game.posterHash ? loaded.get(posterKey(game.id, game.posterHash)) : undefined
    if (url) {
      result.set(game.id, url)
    }
  }
  return result
}
