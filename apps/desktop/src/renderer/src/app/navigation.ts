import type { ModalProps } from 'antd'
import type { MessageKey } from '@savedata-sync/shared'

export type Page = 'devices' | 'games' | 'settings' | 'edit' | 'transfer' | 'task' | 'backup'

export interface Confirmation {
  readonly title: string
  readonly text: string
  readonly work: () => Promise<void>
  readonly okType?: ModalProps['okType']
}

/** 各页标题对应的文案键；按钮名与所打开页面的标题一致。 */
export const PAGE_TITLE_KEYS: Readonly<Record<Page, MessageKey>> = {
  devices: 'nav.devices',
  games: 'nav.games',
  settings: 'nav.settings',
  edit: 'page.gameSettings',
  transfer: 'page.transfer',
  task: 'page.task',
  backup: 'page.backup',
}

export function isRootPage(page: Page): boolean {
  return page === 'games' || page === 'devices' || page === 'settings'
}
