import { randomUUID } from 'node:crypto'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { DEFAULT_APP_PREFERENCES, parseAppPreferences } from '@savedata-sync/shared'
import type { AppPreferences } from '@savedata-sync/shared'

/** 界面偏好保存在应用私有目录；文件缺失或损坏时用默认值，不影响启动。 */
export class AppPreferencesStore {
  private preferences: AppPreferences = DEFAULT_APP_PREFERENCES

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      this.preferences = parseAppPreferences(JSON.parse(await readFile(this.file, 'utf8')))
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        console.error('Failed to read app preferences, using defaults', error)
      }
      this.preferences = DEFAULT_APP_PREFERENCES
    }
  }

  get(): AppPreferences {
    return this.preferences
  }

  async save(preferences: AppPreferences): Promise<void> {
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(preferences), { encoding: 'utf8', flag: 'wx' })
      await rename(temporary, this.file)
      this.preferences = preferences
    } catch (error) {
      await unlink(temporary).catch(() => {})
      throw error
    }
  }
}
