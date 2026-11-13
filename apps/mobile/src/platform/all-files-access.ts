import { Capacitor, registerPlugin } from '@capacitor/core'

/** 所有文件访问权限的状态。 */
export interface AllFilesAccessState {
  /** 应用有所有文件访问权限；有权限时系统存储里的游戏目录直接读写文件。 */
  readonly isGranted: boolean
  /** 添加游戏后的开启提示已经显示过。 */
  readonly wasPrompted: boolean
}

/** 所有文件访问权限的原生插件；方法说明见 {@link AllFilesAccessApi}。 */
interface AllFilesAccessNativePlugin {
  status(): Promise<AllFilesAccessState>
  openSettings(): Promise<AllFilesAccessState>
  markPrompted(): Promise<AllFilesAccessState>
}

/** 网页使用的所有文件访问权限接口。 */
export interface AllFilesAccessApi {
  /** 查询当前状态；不在 Android 上运行时返回 null。 */
  status(): Promise<AllFilesAccessState | null>
  /** 打开系统的授权页，用户返回应用后给出新的状态；不在 Android 上运行时返回 null。 */
  openSettings(): Promise<AllFilesAccessState | null>
  /** 记下开启提示已经显示过，之后 wasPrompted 为 true；不在 Android 上运行时返回 null。 */
  markPrompted(): Promise<AllFilesAccessState | null>
}

const NATIVE =
  Capacitor.getPlatform() === 'android'
    ? registerPlugin<AllFilesAccessNativePlugin>('AllFilesAccess')
    : null

/** 应用使用的所有文件访问权限接口。 */
export const allFilesAccess: AllFilesAccessApi = {
  status: () => (NATIVE ? NATIVE.status() : Promise.resolve(null)),
  openSettings: () => (NATIVE ? NATIVE.openSettings() : Promise.resolve(null)),
  markPrompted: () => (NATIVE ? NATIVE.markPrompted() : Promise.resolve(null)),
}
