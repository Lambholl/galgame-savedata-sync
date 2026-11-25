import { OperationFailure } from '../../result.ts'
import {
  POSTER_ENCODINGS,
  POSTER_LIMITS,
  POSTER_MIME_TYPES,
  POSTER_OUTPUT,
  detectPosterFormat,
} from '../../poster/poster-contracts.ts'
import type { PosterImageData } from '../../poster/poster-contracts.ts'

function base64ToBytes(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

/** 把 base64 内容解码成 Blob。 */
export function base64ToBlob(data: string, mimeType: string): Blob {
  return new Blob([base64ToBytes(data)], { type: mimeType })
}

/** 把 base64 编码的封面文件解码成 Blob，类型按文件开头的字节判断；判断不出时类型为空。 */
export function posterFileToBlob(data: string): Blob {
  const bytes = base64ToBytes(data)
  const format = detectPosterFormat(bytes)
  return new Blob([bytes], { type: format === null ? '' : POSTER_MIME_TYPES[format] })
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
 * 把下载或选取的图片等比缩小到 POSTER_OUTPUT 的宽高以内，按 POSTER_ENCODINGS 的顺序取 WebView 能编码的第一种格式。
 *
 * @returns base64 编码的封面文件。
 * @throws OperationFailure 图片解码不了时 code 为 invalid-request；结果超过
 *   POSTER_LIMITS.maxSavedBytes 时为 resource-limit；WebView 一种格式都编码不了时为 internal-error。
 */
export async function encodePosterImage(image: PosterImageData): Promise<string> {
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
  // 编码不了某种格式时 toBlob 不报错，而是改用 PNG，所以按结果的类型判断，例如 WebKit 不能编码 WebP。
  let blob: Blob | null = null
  for (const format of POSTER_ENCODINGS) {
    const mimeType = POSTER_MIME_TYPES[format]
    const encoded = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, mimeType, POSTER_OUTPUT.quality),
    )
    if (encoded?.type === mimeType) {
      blob = encoded
      break
    }
  }
  if (!blob) {
    throw new OperationFailure('internal-error', 'The poster cannot be encoded.')
  }
  if (blob.size > POSTER_LIMITS.maxSavedBytes) {
    throw new OperationFailure('resource-limit', 'The encoded poster is too large.')
  }
  return blobToBase64(blob)
}
