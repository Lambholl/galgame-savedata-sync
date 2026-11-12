import type { ModalProps } from 'antd'
import type { MessageKey } from '@savedata-sync/shared'

/** 桌面应用的页面。 */
export type Page = 'devices' | 'games' | 'settings' | 'edit' | 'transfer' | 'task' | 'backup'

/** 重新显示一个页面需要的上下文。 */
export interface PageContext {
  readonly gameId: string
  readonly taskProjectId: string | null
  readonly taskCopyId: string | null
  readonly taskRestoreId: string | null
}

/** 一次确认弹窗的内容和确认后执行的操作。 */
export interface Confirmation {
  readonly title: string
  readonly text: string
  readonly work: () => Promise<void>
  readonly okType?: ModalProps['okType']
}

/** 各页标题对应的文案键。 */
export const PAGE_TITLE_KEYS: Readonly<Record<Page, MessageKey>> = {
  devices: 'nav.devices',
  games: 'nav.games',
  settings: 'nav.settings',
  edit: 'page.gameSettings',
  transfer: 'page.transfer',
  task: 'page.task',
  backup: 'page.backup',
}

/** 判断页面是否是侧边导航里的一级页面。 */
export function isRootPage(page: Page): boolean {
  return page === 'games' || page === 'devices' || page === 'settings'
}
