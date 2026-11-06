/** 一次构建的版本：界面和桌面打包用的版本名，以及 Android versionCode。 */
export interface AppVersion {
  readonly name: string
  readonly code: number
}

export declare const UNKNOWN_APP_VERSION: AppVersion
export declare function parseReleaseTag(tag: string): AppVersion | null
export declare function parseDescribeOutput(output: string): AppVersion | null
export declare function resolveAppVersion(options?: {
  readonly env?: NodeJS.ProcessEnv
  readonly cwd?: string
}): AppVersion
