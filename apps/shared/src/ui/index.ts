// 双端共用的界面渲染（ADR-0002）。只放与两端交互差异无关的展示组件；
// 主入口 `@savedata-sync/shared` 不得导入本目录。
export * from './path-text/PathText.tsx'
