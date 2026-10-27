import type { ModalProps } from 'antd'

export type Page =
  'devices' | 'games' | 'settings' | 'edit' | 'transfer' | 'preview' | 'task' | 'backup'

export interface Confirmation {
  readonly title: string
  readonly text: string
  readonly work: () => Promise<void>
  readonly okType?: ModalProps['okType']
}

export interface BackButtonController {
  subscribe(handler: () => boolean): () => void
}

export const PAGE_TITLES: Readonly<Record<Page, string>> = {
  devices: '设备',
  games: '游戏',
  settings: '设置',
  edit: '游戏目录',
  transfer: '传输存档',
  preview: '确认本次变化',
  task: '传输详情',
  backup: '备份与恢复',
}

export function isRootPage(page: Page): boolean {
  return page === 'games' || page === 'devices' || page === 'settings'
}
