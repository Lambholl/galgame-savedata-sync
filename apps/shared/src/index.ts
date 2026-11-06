/** 两端的 Vite 构建配置把 scripts/app-version.mjs 算出的版本名注入到这里。 */
declare const SAVEDATA_SYNC_VERSION: string | undefined

/**
 * 界面显示的版本号，由 Git tag 推算：发布版如 0.3.0，开发版如 0.3.0+12.gcfb3753。
 * 用 Node 直接运行共享代码（例如测试）时没有注入，取 0.0.0+unknown。
 */
export const APP_VERSION: string =
  typeof SAVEDATA_SYNC_VERSION === 'string' ? SAVEDATA_SYNC_VERSION : '0.0.0+unknown'

export * from './protocol/contracts.ts'
export * from './protocol/protocol.ts'
export * from './protocol/validation.ts'
export * from './protocol/batch-contracts.ts'
export * from './protocol/batch-limits.ts'
export * from './protocol/batch-validation.ts'
export * from './protocol/batch-context.ts'
export * from './library/library.ts'
export * from './library/game-links.ts'
export * from './library/project-binding.ts'
export * from './result.ts'
export * from './transfer/transfer.ts'
export * from './transfer/transfer-selection.ts'
export * from './sync/sync-contracts.ts'
export * from './sync/sync-paths.ts'
export * from './sync/sync-validation.ts'
export * from './sync/sync-plan.ts'
export * from './sync/sync-plan-validation.ts'
export * from './sync/sync-result-validation.ts'
export * from './sync/sync-job-contracts.ts'
export * from './sync/sync-job-validation.ts'
export * from './sync/sync-job-observation.ts'
export * from './sync/interrupted-write.ts'
export * from './control/control-contracts.ts'
export * from './control/control-validation.ts'
export * from './connection/connection-address.ts'
export * from './connection/connection-qr.ts'
export * from './connection/discovery.ts'
export * from './display/path-text.ts'
export * from './preferences/app-preferences.ts'
export * from './preferences/design-tokens.ts'
export * from './i18n/messages.ts'
export * from './i18n/translate.ts'
export * from './i18n/format.ts'
export * from './sync/snapshot-compare.ts'
export * from './sync/backup-retention.ts'
