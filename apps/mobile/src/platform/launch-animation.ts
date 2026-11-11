import { Capacitor, registerPlugin } from '@capacitor/core'

interface LaunchAnimationPlugin {
  /** 通知原生等待首屏可绘制；接口无参数和返回值，重复调用安全。 */
  ready(): Promise<void>
}

const NATIVE =
  Capacitor.getPlatform() === 'android'
    ? registerPlugin<LaunchAnimationPlugin>('LaunchAnimation')
    : null

/** 通知原生层首屏已提交，可以结束开屏动画；不在 Android 上运行时直接返回，失败只写入控制台。 */
export function finishStartup(): void {
  NATIVE?.ready().catch((error: unknown) => {
    console.error('Failed to finish launch animation', error)
  })
}
