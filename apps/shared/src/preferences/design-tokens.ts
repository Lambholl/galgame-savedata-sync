import type { ResolvedTheme } from './app-preferences.ts'

/**
 * 原型 v2 的设计变量，双端外观的唯一来源。
 * 样式表通过 --ss-* 变量引用（见 designCssText），antd 主题与原生窗口背景直接读取这里的取值；
 * 组件和样式表里不写颜色、圆角和字体的字面值。
 *
 * 语义色：warn = 内容不同/将覆盖，only = 只在一端有，ok = 新建/成功，danger = 失败/备份关闭，img = 图片。
 */
export interface Palette {
  /** 页面底色；深色为纯黑。 */
  readonly bg: string
  /** 浅色页面渐变的两端。 */
  readonly appA: string
  readonly appB: string
  readonly pageBg: string
  /** 顶栏、底栏等界面框架。 */
  readonly chrome: string
  /** 桌面侧栏。 */
  readonly side: string
  /** 分组容器和卡片。 */
  readonly group: string
  /** 容器里的次级底色：图标底、输入框、轨道。 */
  readonly raised: string
  readonly fg: string
  readonly muted: string
  readonly faint: string
  readonly line: string
  readonly accent: string
  readonly accentFg: string
  readonly accentSoft: string
  readonly ok: string
  readonly okSoft: string
  readonly warn: string
  readonly warnSoft: string
  readonly only: string
  readonly onlySoft: string
  readonly img: string
  readonly imgSoft: string
  readonly danger: string
  readonly dangerSoft: string
  readonly scrim: string
  readonly shadow: string
  /** 游戏占位封面的四组渐变与封面上的文字、描边；明暗相同。 */
  readonly cover0: string
  readonly cover1: string
  readonly cover2: string
  readonly cover3: string
  readonly onCover: string
  readonly onCoverLine: string
}

const COVERS = {
  cover0: 'linear-gradient(155deg, #c3dcf2, #7b9fc8 45%, #2f4a7d)',
  cover1: 'linear-gradient(155deg, #f2d9c6, #c497ae 50%, #5f507f)',
  cover2: 'linear-gradient(155deg, #cdeadf, #74b2a6 50%, #2e5e66)',
  cover3: 'linear-gradient(155deg, #e7dcf6, #9b8ad0 50%, #3f3b78)',
  onCover: '#ffffff',
  onCoverLine: 'rgb(255 255 255 / 35%)',
} as const

export const PALETTES: Readonly<Record<ResolvedTheme, Palette>> = {
  light: {
    bg: '#e9edf5',
    appA: '#eaf0fb',
    appB: '#ece8f8',
    pageBg: 'linear-gradient(165deg, var(--ss-app-a), var(--ss-app-b))',
    chrome: '#f7f8fc',
    side: 'rgba(255, 255, 255, 0.6)',
    group: '#ffffff',
    raised: '#f1f4f9',
    fg: '#172033',
    muted: '#5d687c',
    faint: '#8c96a8',
    line: '#dde3ed',
    accent: '#286add',
    accentFg: '#ffffff',
    accentSoft: '#e5edfc',
    ok: '#18915a',
    okSoft: '#e0f3e9',
    warn: '#b86e00',
    warnSoft: '#fdefd6',
    only: '#2b74c9',
    onlySoft: '#dcebfb',
    img: '#0f8a8a',
    imgSoft: '#dcf2f1',
    danger: '#cc3340',
    dangerSoft: '#fbe4e6',
    scrim: 'rgba(18, 24, 38, 0.38)',
    shadow: '0 1px 2px rgba(23, 32, 51, 0.06), 0 6px 18px rgba(23, 32, 51, 0.06)',
    ...COVERS,
  },
  dark: {
    bg: '#000000',
    appA: '#000000',
    appB: '#000000',
    pageBg: '#000000',
    chrome: '#0f1116',
    side: '#0b0c0f',
    group: '#141518',
    raised: '#1f2126',
    fg: '#eef1f6',
    muted: '#a3acbb',
    faint: '#737d8e',
    line: '#262a32',
    accent: '#5b8ff0',
    accentFg: '#ffffff',
    accentSoft: '#17233b',
    ok: '#45c088',
    okSoft: '#10291d',
    warn: '#e5a23a',
    warnSoft: '#33240b',
    only: '#63a6f2',
    onlySoft: '#102640',
    img: '#4cc4c0',
    imgSoft: '#0d2a2a',
    danger: '#f0707a',
    dangerSoft: '#3a1418',
    scrim: 'rgba(0, 0, 0, 0.6)',
    shadow: '0 1px 2px rgba(0, 0, 0, 0.5)',
    ...COVERS,
  },
}

/**
 * 圆角只用这几档（px）：xs 小图标底，sm 输入框和分段控件，md 分组容器、卡片、文件列和大图标底，
 * lg 弹层，pill 按钮和标签；圆形用 50%，不另设档位。
 */
export const RADII = { xs: 6, sm: 10, md: 14, lg: 22, pill: 999 } as const

export const FONTS = {
  body: "'Segoe UI', 'PingFang SC', 'HarmonyOS Sans SC', 'Microsoft YaHei', system-ui, sans-serif",
  mono: "'Cascadia Mono', Consolas, 'SFMono-Regular', monospace",
} as const

function kebab(name: string): string {
  return name.replace(/[A-Z0-9]/g, (part) => `-${part.toLowerCase()}`)
}

function declarations(values: Readonly<Record<string, string>>): string {
  return Object.entries(values)
    .map(([name, value]) => `--ss-${kebab(name)}:${value};`)
    .join('')
}

/**
 * 生成挂到 <html> 上的 --ss-* 变量：:root 为浅色，[data-theme='dark'] 为深色。
 * 应用在 <html> 上设置已解析主题 data-theme="light|dark"。
 */
export function designCssText(): string {
  const shared = declarations({
    rXs: `${RADII.xs}px`,
    rSm: `${RADII.sm}px`,
    rMd: `${RADII.md}px`,
    rLg: `${RADII.lg}px`,
    rPill: `${RADII.pill}px`,
    font: FONTS.body,
    mono: FONTS.mono,
  })
  return (
    `:root{${declarations({ ...PALETTES.light })}${shared}color-scheme:light;}` +
    `:root[data-theme='dark']{${declarations({ ...PALETTES.dark })}color-scheme:dark;}`
  )
}
