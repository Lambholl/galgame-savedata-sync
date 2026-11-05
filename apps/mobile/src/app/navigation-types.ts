import type { MessageKey } from '@savedata-sync/shared'
export type Page =
  'devices' | 'games' | 'settings' | 'edit' | 'task' | 'backup' | 'restore' | 'sync' | 'sync-plan'

/** 重新显示一个页面需要的上下文，随来源记录保存。连接设备的选择不在其中：返回时沿用最新的选择。 */
export interface PageContext {
  readonly gameId: string
  readonly taskProjectId: string | null
}

export interface Confirmation {
  readonly title: string
  readonly text: string
  readonly work: () => Promise<void>
  readonly okType?: 'danger' | 'primary'
}

/** 返回处理器返回 true 时消费事件；取消订阅释放原生监听。 */
export interface BackButtonController {
  subscribe(handler: () => boolean): () => void
}

/** 各页标题对应的文案键；按钮名与所打开页面的标题一致。 */
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
}

export function isRootPage(page: Page): boolean {
  return page === 'games' || page === 'devices' || page === 'settings'
}
