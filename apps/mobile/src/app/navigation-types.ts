import type { MessageKey } from '@savedata-sync/shared'
/** 移动应用的页面。 */
export type Page =
  | 'devices'
  | 'games'
  | 'settings'
  | 'edit'
  | 'task'
  | 'backup'
  | 'restore'
  | 'sync'
  | 'sync-plan'
  | 'scan'

/** 重新显示一个页面需要的上下文。 */
export interface PageContext {
  readonly gameId: string
  readonly taskProjectId: string | null
}

/** 一次确认弹层的内容和确认后执行的操作。 */
export interface Confirmation {
  readonly title: string
  readonly text: string
  readonly work: () => Promise<void>
  readonly okType?: 'danger' | 'primary'
}

/** 系统返回键。 */
export interface BackButtonController {
  /** 订阅返回键；handler 返回 true 表示已处理。返回取消订阅的函数。 */
  subscribe(handler: () => boolean): () => void
}

/** 各页标题对应的文案键。 */
export const PAGE_TITLE_KEYS: Readonly<Record<Page, MessageKey>> = {
  devices: 'nav.devices',
  games: 'nav.games',
  settings: 'nav.settings',
  edit: 'page.gameSettings',
  task: 'page.task',
  backup: 'page.backup',
  restore: 'backup.restoreTask',
  sync: 'page.transfer',
  'sync-plan': 'page.plan',
  scan: 'device.scanTitle',
}

/** 判断页面是否是主导航里的一级页面。 */
export function isRootPage(page: Page): boolean {
  return page === 'games' || page === 'devices' || page === 'settings'
}
