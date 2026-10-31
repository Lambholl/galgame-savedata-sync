import type { ResolvedTheme } from './app-preferences.ts'

/** 两端 antd / antd-mobile 主题需要的共用取值，与 ui/tokens.css 保持一致。 */
export interface ThemeTokens {
  readonly colorPrimary: string
  readonly colorBgLayout: string
  readonly colorBgContainer: string
  readonly colorText: string
  readonly colorBorderSecondary: string
  /** 常规控件圆角。 */
  readonly borderRadius: number
  /** 卡片、弹层等大块容器圆角。 */
  readonly borderRadiusLG: number
  /** 标签、小按钮圆角。 */
  readonly borderRadiusSM: number
}

const LIGHT: ThemeTokens = {
  colorPrimary: '#286add',
  colorBgLayout: '#e9edf5',
  colorBgContainer: '#ffffff',
  colorText: '#172033',
  colorBorderSecondary: '#dde3ed',
  borderRadius: 10,
  borderRadiusLG: 14,
  borderRadiusSM: 6,
}

const DARK: ThemeTokens = {
  colorPrimary: '#5b8ff0',
  colorBgLayout: '#000000',
  colorBgContainer: '#141518',
  colorText: '#eef1f6',
  colorBorderSecondary: '#262a32',
  borderRadius: 10,
  borderRadiusLG: 14,
  borderRadiusSM: 6,
}

export function themeTokens(theme: ResolvedTheme): ThemeTokens {
  return theme === 'dark' ? DARK : LIGHT
}
