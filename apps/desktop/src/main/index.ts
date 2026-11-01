import { app, BrowserWindow, dialog, ipcMain, nativeTheme } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir, realpath } from 'node:fs/promises'
import { createTranslator, resolveLocale } from '@savedata-sync/shared'
import type { Translate } from '@savedata-sync/shared'
import { createDirectoryAdapter } from './directory-adapter.ts'
import { isTrustedDirectorySender, registerDirectoryIpc } from './directory-ipc.ts'
import { toDirectoryError } from './directory-errors.ts'
import { createWindowsArchiveAdapter } from './archive-adapter.ts'
import { WindowsHttpService } from './http-service.ts'
import { HttpOperationError, toHttpError } from './http-errors.ts'
import { WindowsNewFilePublisher } from './new-file-publisher.ts'
import { registerServiceIpc } from './service-ipc.ts'
import { ServicePortSettings } from './service-port-settings.ts'
import { DesktopLibrary } from './library-store.ts'
import { registerLibraryIpc } from './library-ipc.ts'
import { createWindowsBackupStore } from './backup-store.ts'
import { registerBackupIpc } from './backup-ipc.ts'
import { WindowsSyncWriter } from './sync-writer.ts'
import { WindowsRestoreRegistry } from './restore-registry.ts'
import { registerSyncIpc } from './sync-ipc.ts'
import { AppPreferencesStore } from './preferences-store.ts'
import { registerPreferencesIpc } from './preferences-ipc.ts'
import appIcon from '../../resources/app-icon.ico?asset&asarUnpack'

const trustedWindows = new Set<number>()
const rendererUrl = process.env.ELECTRON_RENDERER_URL
const rendererFileUrl = new URL('../renderer/index.html', import.meta.url)
const expectedRendererUrl = rendererUrl ? new URL(rendererUrl).href : rendererFileUrl.href
let preferencesStore: AppPreferencesStore | null = null

/** 原生窗口与系统弹窗每次按已保存偏好取文案；配置未读到时跟随系统。 */
function getT(): Translate {
  return createTranslator(
    resolveLocale(preferencesStore?.get().locale ?? 'system', app.getPreferredSystemLanguages()),
  )
}

function createWindow(): void {
  const getBackgroundColor = (): string => (nativeTheme.shouldUseDarkColors ? '#000000' : '#f5f5f5')
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 520,
    title: getT()('app.name'),
    icon: appIcon,
    backgroundColor: getBackgroundColor(),
    webPreferences: {
      preload: fileURLToPath(new URL('../preload/index.cjs', import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  trustedWindows.add(window.webContents.id)
  const webContentsId = window.webContents.id
  const updateBackground = (): void => window.setBackgroundColor(getBackgroundColor())
  nativeTheme.on('updated', updateBackground)
  window.once('closed', () => {
    trustedWindows.delete(webContentsId)
    nativeTheme.removeListener('updated', updateBackground)
  })

  const loading = rendererUrl
    ? window.loadURL(rendererUrl)
    : window.loadFile(fileURLToPath(new URL('../renderer/index.html', import.meta.url)))
  loading.catch((error: unknown) => {
    console.error('Failed to load desktop renderer', error)
    const t = getT()
    dialog.showErrorBox(t('app.loadUiFailedTitle'), t('app.loadUiFailed'))
  })
}

const hasInstanceLock = app.requestSingleInstanceLock()
if (!hasInstanceLock) {
  app.quit()
}

if (hasInstanceLock) {
  app
    .whenReady()
    .then(async () => {
      // 平台提供的应用私有目录可能经过系统重定向；先解析它，再执行缓存的逐段检查。
      // 用户选择的存档目录仍由目录适配器独立拒绝链接和越界。
      await mkdir(app.getPath('userData'), { recursive: true })
      const privateDirectory = await realpath(app.getPath('userData'))
      const adapter = await createDirectoryAdapter(join(privateDirectory, 'directory-config.json'))
      const archive = await createWindowsArchiveAdapter(adapter, privateDirectory)
      // 网络监听由本机界面启动；已配置的存档目录在每次接收前重新核实写入权限。
      const publisher = new WindowsNewFilePublisher(adapter)
      const library = new DesktopLibrary(join(privateDirectory, 'game-library.json'), adapter)
      await library.load()
      const backups = await createWindowsBackupStore(adapter, privateDirectory)
      const syncWriter = new WindowsSyncWriter(adapter, backups, {
        authorize: (plan) => {
          if (
            !library
              .snapshot()
              .config.games.some(
                (game) => game.id === plan.projectId && game.rootId === plan.target.rootId,
              )
          ) {
            throw new HttpOperationError(
              'permission-denied',
              'The target directory does not match the local project configuration.',
            )
          }
        },
      })
      const preferences = new AppPreferencesStore(join(privateDirectory, 'app-preferences.json'))
      await preferences.load()
      preferencesStore = preferences
      // themeSource 同时决定原生窗口背景和渲染页的 prefers-color-scheme。
      nativeTheme.themeSource = preferences.get().theme
      app.once(
        'will-quit',
        registerPreferencesIpc(
          ipcMain,
          preferences,
          (event) => isTrustedDirectorySender(event, trustedWindows, expectedRendererUrl),
          (value) => {
            nativeTheme.themeSource = value.theme
          },
        ),
      )
      const portSettings = new ServicePortSettings(join(privateDirectory, 'service-settings.json'))
      await portSettings.load()
      const httpService = new WindowsHttpService(adapter, archive, {
        scanSource: adapter,
        publisher,
        library,
        sync: { writer: syncWriter, backups, archive },
        authorizeTarget: async (rootId) => {
          if (!library.snapshot().config.games.some((game) => game.rootId === rootId)) {
            throw new HttpOperationError(
              'permission-denied',
              'The receive directory is not configured for a game.',
            )
          }
          await publisher.grant(rootId)
        },
      })
      const restores = new WindowsRestoreRegistry({
        source: adapter,
        backups,
        writer: syncWriter,
        library,
      })
      app.once(
        'will-quit',
        registerSyncIpc(ipcMain, httpService, restores, (event) =>
          isTrustedDirectorySender(event, trustedWindows, expectedRendererUrl),
        ),
      )
      app.once(
        'will-quit',
        registerBackupIpc(
          ipcMain,
          backups,
          library,
          (event) => isTrustedDirectorySender(event, trustedWindows, expectedRendererUrl),
          () => httpService.hasRunningNetworkWork() || restores.hasRunningWork(),
        ),
      )
      app.once(
        'will-quit',
        registerLibraryIpc(ipcMain, library, httpService, (event) =>
          isTrustedDirectorySender(event, trustedWindows, expectedRendererUrl),
        ),
      )
      let canQuit = false
      let isClosing = false
      app.on('before-quit', (event) => {
        if (canQuit) {
          return
        }
        event.preventDefault()
        if (isClosing) {
          return
        }
        isClosing = true
        httpService
          .stop()
          .then(() => restores.stop())
          .then(() => Promise.allSettled([publisher.stop(), syncWriter.stop()]))
          .then(async (results) => {
            for (const result of results) {
              if (result.status === 'rejected') {
                throw toHttpError(result.reason)
              }
            }
            // 目标任务释放成功后再关闭备份，清理失败时保留存储供重试。
            await backups.stop()
            canQuit = true
            app.quit()
          })
          .catch((error: unknown) => {
            isClosing = false
            console.error('Failed to release desktop resources', toHttpError(error).operationError)
            const t = getT()
            dialog.showErrorBox(t('app.cleanupFailedTitle'), t('app.cleanupFailed'))
          })
      })
      const disposeDirectoryIpc = registerDirectoryIpc(ipcMain, adapter, {
        choosePath: async () => {
          const result = await dialog.showOpenDialog({
            title: getT()('game.chooseFolder'),
            properties: ['openDirectory', 'dontAddToRecent'],
          })
          return result.canceled ? null : (result.filePaths[0] ?? null)
        },
        isTrustedSender: (event) =>
          isTrustedDirectorySender(event, trustedWindows, expectedRendererUrl),
      })
      app.once('will-quit', disposeDirectoryIpc)
      const disposeServiceIpc = registerServiceIpc(ipcMain, adapter, httpService, publisher, {
        portSettings,
        isTrustedSender: (event) =>
          isTrustedDirectorySender(event, trustedWindows, expectedRendererUrl),
        chooseTargetPath: async () => {
          const result = await dialog.showOpenDialog({
            title: getT()('game.chooseFolder'),
            properties: ['openDirectory', 'dontAddToRecent'],
          })
          const path = result.canceled ? null : (result.filePaths[0] ?? null)
          if (path === null) {
            return null
          }
          return path
        },
      })
      app.once('will-quit', disposeServiceIpc)
      createWindow()
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          createWindow()
        }
      })
    })
    .catch((error: unknown) => {
      console.error(
        'Failed to initialize desktop application',
        toDirectoryError(error).operationError,
      )
      const t = getT()
      dialog.showErrorBox(t('app.initializeFailedTitle'), t('app.initializeFailed'))
      app.exit(1)
    })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
