// 双端共用的界面渲染（ADR-0002）。只放与两端交互差异无关的展示组件；
// 主入口 `@savedata-sync/shared` 不得导入本目录。
export * from './path-text/PathText.tsx'
export * from './i18n/I18nProvider.tsx'
export * from './files/FileIcon.tsx'
export * from './transfer/TransferComparison.tsx'
export { useLocale, useT } from './i18n/i18n-context.ts'
export type { I18nValue } from './i18n/i18n-context.ts'
