import type { DevicePlatform } from '@savedata-sync/shared'

/** 本机在设备描述、发现广播、目录表交换和封面请求的 User-Agent 里上报的平台。 */
export const LOCAL_PLATFORM: DevicePlatform = process.platform === 'linux' ? 'linux' : 'windows'
