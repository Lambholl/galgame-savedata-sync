import { App as CapacitorApp } from '@capacitor/app'
import { Capacitor, registerPlugin } from '@capacitor/core'
import type { PluginListenerHandle } from '@capacitor/core'

/** 打开相机的结果：started 表示取景画面已在 WebView 下面，denied 表示没有相机权限，failed 表示相机打不开或不是 Android 应用。 */
export type QrScannerStartStatus = 'started' | 'denied' | 'failed'

/** 网页使用的二维码扫描。取景画面由原生层放在透明的 WebView 下面，页面要让出背景才看得见。 */
export interface QrScannerApi {
  /** 需要时申请相机权限，然后打开后置相机并开始识别。不会 reject，失败时 resolve `failed`。 */
  start(): Promise<QrScannerStartStatus>
  /** 关闭相机并移除取景画面。没有打开相机时不做任何事。 */
  stop(): void
  /**
   * 订阅识别结果。listener 收到二维码的原始文本，同一段文本每 2 秒最多一次，内容未经校验。
   * 返回的函数取消订阅，页面离开时调用。
   */
  watchDetected(listener: (text: string) => void): () => void
  /**
   * 应用回到前台时检查相机权限，已授权就调用 listener。用于用户从系统设置授权后返回的情况。
   * 返回的函数取消监听，页面离开时调用。
   */
  watchPermissionGranted(listener: () => void): () => void
  /** 打开本应用的系统设置页。 */
  openAppSettings(): void
}

/** Capacitor 原生插件 QrScanner；返回值和事件都未经校验。 */
export interface QrScannerNativePlugin {
  start(): Promise<unknown>
  stop(): Promise<unknown>
  checkPermissions(): Promise<unknown>
  openAppSettings(): Promise<unknown>
  addListener(
    event: 'qrDetected',
    callback: (detected: unknown) => void,
  ): Promise<PluginListenerHandle>
}

function readString(value: unknown, field: string): string | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const item = (value as Readonly<Record<string, unknown>>)[field]
  return typeof item === 'string' ? item : null
}

function removeWhenReady(handle: Promise<PluginListenerHandle>, purpose: string): () => void {
  handle.catch((cause: unknown) => {
    console.error(`Failed to listen for ${purpose}`, cause)
  })
  return () => {
    handle
      .then((listener) => listener.remove())
      .catch((cause: unknown) => {
        console.error(`Failed to stop listening for ${purpose}`, cause)
      })
  }
}

/** 包装原生插件；plugin 为 null 时（浏览器预览）start 回报 failed，其余方法不做任何事。 */
export function createQrScanner(plugin: QrScannerNativePlugin | null): QrScannerApi {
  return {
    async start() {
      try {
        const status = plugin && readString(await plugin.start(), 'status')
        return status === 'started' || status === 'denied' ? status : 'failed'
      } catch (cause) {
        console.error('Failed to start the QR scanner', cause)
        return 'failed'
      }
    },
    stop() {
      plugin?.stop().catch((cause: unknown) => {
        console.error('Failed to stop the QR scanner', cause)
      })
    },
    watchDetected(listener) {
      if (plugin === null) {
        return () => undefined
      }
      return removeWhenReady(
        plugin.addListener('qrDetected', (detected) => {
          const text = readString(detected, 'text')
          if (text !== null) {
            listener(text)
          }
        }),
        'detected QR codes',
      )
    },
    watchPermissionGranted(listener) {
      if (plugin === null) {
        return () => undefined
      }
      return removeWhenReady(
        CapacitorApp.addListener('resume', () => {
          plugin
            .checkPermissions()
            .then((state) => {
              if (readString(state, 'camera') === 'granted') {
                listener()
              }
            })
            .catch((cause: unknown) => {
              console.error('Failed to check the camera permission', cause)
            })
        }),
        'app resume',
      )
    },
    openAppSettings() {
      plugin?.openAppSettings().catch((cause: unknown) => {
        console.error('Failed to open the app settings', cause)
      })
    },
  }
}

/** 应用使用的二维码扫描。 */
export const qrScanner = createQrScanner(
  Capacitor.getPlatform() === 'android' ? registerPlugin<QrScannerNativePlugin>('QrScanner') : null,
)
