import type { MessageKey } from '@savedata-sync/shared'
export type Page =
  'devices' | 'games' | 'settings' | 'edit' | 'task' | 'backup' | 'sync' | 'sync-plan'

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
  sync: 'page.transfer',
  'sync-plan': 'page.plan',
}

export function isRootPage(page: Page): boolean {
  return page === 'games' || page === 'devices' || page === 'settings'
}
