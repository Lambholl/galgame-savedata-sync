import { theme } from 'antd'
import type { ThemeConfig } from 'antd'
import type { ResolvedTheme } from '../../preferences/app-preferences.ts'
import { FONTS, PALETTES, RADII, designCssText } from '../../preferences/design-tokens.ts'

/** 两端 antd 的组件密度不同，其余主题取值相同。 */
const COMPONENTS = {
  desktop: { Card: { bodyPadding: 20 } },
  // 选择菜单按触控尺寸放大。
  mobile: { Dropdown: { paddingBlock: 12, fontSize: 15 } },
} as const satisfies Record<'desktop' | 'mobile', ThemeConfig['components']>

/**
 * 由设计变量生成两端 ConfigProvider 的主题；antd 需要实际色值推算悬停、浅色背景等派生色，
 * 所以这里读取 design-tokens 里的取值，而不是 CSS 变量。
 */
export function designTheme(resolved: ResolvedTheme, platform: 'desktop' | 'mobile'): ThemeConfig {
  const palette = PALETTES[resolved]
  return {
    algorithm: resolved === 'dark' ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      colorPrimary: palette.accent,
      colorInfo: palette.accent,
      colorSuccess: palette.ok,
      colorWarning: palette.warn,
      colorError: palette.danger,
      colorBgLayout: palette.bg,
      colorBgContainer: palette.group,
      colorText: palette.fg,
      colorTextSecondary: palette.muted,
      colorTextTertiary: palette.faint,
      colorBorderSecondary: palette.line,
      borderRadius: RADII.sm,
      borderRadiusLG: RADII.md,
      borderRadiusSM: RADII.xs,
      fontFamily: FONTS.body,
      fontFamilyCode: FONTS.mono,
    },
    components: {
      // 按钮和标签用胶囊。
      Button: { borderRadius: RADII.pill, borderRadiusLG: RADII.pill, borderRadiusSM: RADII.pill },
      Tag: { borderRadiusSM: RADII.pill },
      ...COMPONENTS[platform],
    },
  }
}

/** 把 --ss-* 设计变量挂到页面上；应用入口在渲染前调用一次。 */
export function installDesignTokens(): void {
  const id = 'ss-design-tokens'
  if (document.getElementById(id)) {
    return
  }
  const style = document.createElement('style')
  style.id = id
  style.textContent = designCssText()
  document.head.prepend(style)
}
