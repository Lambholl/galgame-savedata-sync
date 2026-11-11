import { theme } from 'antd'
import type { ThemeConfig } from 'antd'
import type { ResolvedTheme } from '../../preferences/app-preferences.ts'
import { FONTS, PALETTES, RADII, designCssText } from '../../preferences/design-tokens.ts'

/** ConfigProvider 的 button 配置：关闭两个汉字之间自动插入的空格。 */
export const DESIGN_BUTTON = { autoInsertSpace: false } as const

/** 两端各自的 antd 组件密度。 */
const COMPONENTS = {
  desktop: { Card: { bodyPadding: 20 } },
  // 选择菜单按触控尺寸放大。
  mobile: { Dropdown: { paddingBlock: 12, fontSize: 15 } },
} as const satisfies Record<'desktop' | 'mobile', ThemeConfig['components']>

// antd 要用实际色值推算悬停、浅色背景等派生色，所以读 design-tokens 的取值，没有用 CSS 变量。
/** 按主题和平台生成 antd ConfigProvider 的主题配置。 */
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
      ...(platform === 'desktop'
        ? {
            Menu: {
              // 电脑侧栏自身的右边框已经和正文分隔，Menu 右侧再画一条竖线会显得多余。
              activeBarBorderWidth: 0,
              ...(resolved === 'light'
                ? { itemSelectedBg: palette.accentSoft, itemSelectedColor: palette.accent }
                : {}),
            },
          }
        : {}),
      ...COMPONENTS[platform],
    },
  }
}

/** 在 document.head 开头插入定义 --ss-* 变量的样式表；已经插入过时不再插入。 */
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
