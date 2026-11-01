import { Capacitor, registerPlugin } from '@capacitor/core'

interface LaunchAnimationPlugin {
  /** 通知原生等待首屏可绘制；接口无参数和返回值，重复调用安全。 */
  ready(): Promise<void>
}

const NATIVE =
  Capacitor.getPlatform() === 'android'
    ? registerPlugin<LaunchAnimationPlugin>('LaunchAnimation')
    : null

/** React 首屏或启动错误提示提交后调用原生接口；浏览器预览时直接返回，插件调用失败会写入控制台。 */
export function finishStartup(): void {
  NATIVE?.ready().catch((error: unknown) => {
    console.error('Failed to finish launch animation', error)
  })
}
