export type Page = 'devices' | 'games' | 'settings' | 'edit' | 'task' | 'backup' | 'sync'

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

export const PAGE_TITLES: Readonly<Record<Page, string>> = {
  devices: '设备',
  games: '游戏',
  settings: '设置',
  edit: '游戏目录',
  task: '传输详情',
  backup: '备份与恢复',
  sync: '复制存档',
}

export function isRootPage(page: Page): boolean {
  return page === 'games' || page === 'devices' || page === 'settings'
}
