import { OperationFailure } from '../../result.ts'
import { POSTER_LIMITS, POSTER_OUTPUT } from '../../poster/poster-contracts.ts'
import type { PosterImageData } from '../../poster/poster-contracts.ts'

/** 把 base64 内容解码成 Blob。 */
export function base64ToBlob(data: string, mimeType: string): Blob {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index)
  }
  return new Blob([bytes], { type: mimeType })
}

/** 把 Blob 的内容编码成 base64。 */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  // 分段拼接，避免一次展开几 MB 的参数超出调用栈。
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }
  return btoa(binary)
}

/**
 * 把下载或选取的图片等比缩小到 POSTER_OUTPUT 的宽高以内，编码成 WebP。
 *
 * @returns base64 编码的 WebP。
 * @throws OperationFailure 图片解码不了时 code 为 invalid-request；结果超过
 *   POSTER_LIMITS.maxSavedBytes 时为 resource-limit；WebView 不能用 canvas 编码 WebP 时为 internal-error。
 */
export async function encodePosterWebp(image: PosterImageData): Promise<string> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(base64ToBlob(image.data, image.mimeType))
  } catch {
    // 解码失败只可能是文件内容不是可识别的图片，原因对用户没有更多信息。
    throw new OperationFailure('invalid-request', 'The image cannot be decoded.')
  }
  const scale = Math.min(
    1,
    POSTER_OUTPUT.maxWidth / bitmap.width,
    POSTER_OUTPUT.maxHeight / bitmap.height,
  )
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const context = canvas.getContext('2d')
  if (!context) {
    bitmap.close()
    throw new OperationFailure('internal-error', 'Canvas is unavailable.')
  }
  context.imageSmoothingQuality = 'high'
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/webp', POSTER_OUTPUT.webpQuality),
  )
  // 不支持 WebP 编码的环境会退回 PNG，保存端只收 WebP。
  if (!blob || blob.type !== 'image/webp') {
    throw new OperationFailure('internal-error', 'WebP encoding is unavailable.')
  }
  if (blob.size > POSTER_LIMITS.maxSavedBytes) {
    throw new OperationFailure('resource-limit', 'The encoded poster is too large.')
  }
  return blobToBase64(blob)
}
