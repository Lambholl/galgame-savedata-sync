import { useEffect, useRef, useState } from 'react'
import { POSTER_LIMITS } from '../../poster/poster-contracts.ts'
import type { PosterAdapter } from '../../poster/poster-adapter.ts'
import { base64ToBlob } from './poster-image.ts'

/** 按 POSTER_LIMITS.maxPreviewDownloads 限制并发下载预览图，下好的转成 blob 地址。 */
class PreviewDownloads {
  readonly #adapter: Pick<PosterAdapter, 'downloadImage'>
  readonly #onChange: (urls: ReadonlyMap<string, string>) => void
  // 键是图片地址，值是 blob 地址。
  readonly #loaded = new Map<string, string>()
  readonly #failed = new Set<string>()
  readonly #active = new Set<string>()
  #queue: string[] = []
  #isDisposed = false

  constructor(
    adapter: Pick<PosterAdapter, 'downloadImage'>,
    onChange: (urls: ReadonlyMap<string, string>) => void,
  ) {
    this.#adapter = adapter
    this.#onChange = onChange
  }

  /** 换成只排队这些地址；已经下好、失败过和正在下载的地址跳过。 */
  want(urls: readonly string[]): void {
    this.#queue = urls.filter(
      (url) => !this.#loaded.has(url) && !this.#failed.has(url) && !this.#active.has(url),
    )
    this.#pump()
  }

  /** 释放全部 blob 地址，之后完成的下载丢弃。 */
  dispose(): void {
    this.#isDisposed = true
    this.#queue = []
    for (const url of this.#loaded.values()) {
      URL.revokeObjectURL(url)
    }
    this.#loaded.clear()
  }

  #pump(): void {
    while (this.#active.size < POSTER_LIMITS.maxPreviewDownloads) {
      const url = this.#queue.shift()
      if (url === undefined) {
        return
      }
      this.#active.add(url)
      this.#adapter
        .downloadImage(url)
        .then(
          (image) => {
            if (this.#isDisposed) {
              return
            }
            this.#loaded.set(url, URL.createObjectURL(base64ToBlob(image.data, image.mimeType)))
            this.#onChange(new Map(this.#loaded))
          },
          () => {
            // 下载失败的预览显示占位封面，不重试：同一次搜索里重试多半还是失败，还占着并发名额。
            this.#failed.add(url)
          },
        )
        .finally(() => {
          this.#active.delete(url)
          if (!this.#isDisposed) {
            this.#pump()
          }
        })
    }
  }
}

/**
 * 下载候选的预览图，转成可以给 img 用的 blob 地址。
 *
 * @param urls 当前要显示的预览图地址，按顺序排队；不再出现的地址如果还没开始下载就不再下载。
 * @returns 键是图片地址；还没下好或下载失败的地址不在里面。组件卸载时释放全部地址。
 */
export function usePreviewUrls(
  urls: readonly string[],
  adapter: Pick<PosterAdapter, 'downloadImage'>,
): ReadonlyMap<string, string> {
  const downloadsRef = useRef<PreviewDownloads | null>(null)
  const [loaded, setLoaded] = useState<ReadonlyMap<string, string>>(() => new Map())
  const wantedKey = urls.join('\n')

  useEffect(() => {
    const downloads = new PreviewDownloads(adapter, setLoaded)
    downloadsRef.current = downloads
    return () => {
      downloads.dispose()
      downloadsRef.current = null
    }
  }, [adapter])

  useEffect(() => {
    downloadsRef.current?.want(wantedKey === '' ? [] : wantedKey.split('\n'))
  }, [wantedKey, adapter])

  return loaded
}
