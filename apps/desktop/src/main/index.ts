import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { fileURLToPath } from 'node:url'
import { PALETTES } from '@savedata-sync/shared'
import { BackendStartError, startBackend } from '../backend/backend.ts'
import type { DesktopBackend } from '../backend/backend.ts'
import { BACKUP_CHANNELS } from '../bridge/backup-bridge.ts'
import { DIALER_CHANNELS } from '../bridge/dialer-bridge.ts'
import { DIRECTORY_CHANNELS } from '../bridge/directory-bridge.ts'
import { LIBRARY_CHANNELS } from '../bridge/library-bridge.ts'
import { PREFERENCES_CHANNELS } from '../bridge/preferences-bridge.ts'
import { SERVICE_CHANNELS } from '../bridge/service-bridge.ts'
import { SYNC_CHANNELS } from '../bridge/sync-bridge.ts'
import appIcon from '../../resources/app-icon.ico?asset&asarUnpack'

const trustedWindows = new Set<number>()
const rendererUrl = process.env.ELECTRON_RENDERER_URL
const rendererFileUrl = new URL('../renderer/index.html', import.meta.url)
const expectedRendererUrl = rendererUrl ? new URL(rendererUrl).href : rendererFileUrl.href
const CHANNELS = [
  BACKUP_CHANNELS,
  DIALER_CHANNELS,
  DIRECTORY_CHANNELS,
  LIBRARY_CHANNELS,
  PREFERENCES_CHANNELS,
  SERVICE_CHANNELS,
  SYNC_CHANNELS,
].flatMap((group) => Object.values(group))
const FORBIDDEN = {
  status: 'error',
  error: {
    code: 'permission-denied',
    message: 'This page cannot access the desktop service.',
    canRetry: false,
  },
} as const

/** 判断 IPC 发送方是否可信：发送方是 trustedWindows 里窗口的主 frame，且 URL 是应用自己的页面。 */
function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  return (
    trustedWindows.has(event.sender.id) &&
    event.senderFrame === event.sender.mainFrame &&
    event.senderFrame?.url === expectedRendererUrl
  )
}

function createWindow(backend: DesktopBackend): void {
  const getBackgroundColor = (): string =>
    PALETTES[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'].bg
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 520,
    title: backend.translate()('app.name'),
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
    : window.loadFile(fileURLToPath(rendererFileUrl))
  loading.catch((error: unknown) => {
    console.error('Failed to load desktop renderer', error)
    const t = backend.translate()
    dialog.showErrorBox(t('app.loadUiFailedTitle'), t('app.loadUiFailed'))
  })
}

const hasInstanceLock = app.requestSingleInstanceLock()
if (!hasInstanceLock) {
  app.quit()
}

if (hasInstanceLock) {
  // 页面自带导航，不需要 Electron 默认的 File、Edit 等菜单。
  // 设为 null 后，Windows 窗口不显示菜单栏，按 Alt 也不会弹出。
  Menu.setApplicationMenu(null)
  app
    .whenReady()
    .then(async () => {
      const backend = await startBackend({
        dataDirectory: app.getPath('userData'),
        systemLanguages: app.getPreferredSystemLanguages(),
        host: {
          chooseDirectory: async (title) => {
            const result = await dialog.showOpenDialog({
              title,
              properties: ['openDirectory', 'dontAddToRecent'],
            })
            return result.canceled ? null : (result.filePaths[0] ?? null)
          },
          openPath: async (path) => {
            const failure = await shell.openPath(path)
            if (failure) {
              throw new Error(failure)
            }
          },
          setTheme: (theme) => {
            // themeSource 同时决定原生窗口背景和渲染页的 prefers-color-scheme。
            nativeTheme.themeSource = theme
          },
        },
      })
      for (const channel of CHANNELS) {
        ipcMain.handle(channel, (event, ...args: unknown[]) =>
          isTrustedSender(event) ? backend.router.invoke(channel, args) : FORBIDDEN,
        )
      }
      app.once('will-quit', () => {
        for (const channel of CHANNELS) {
          ipcMain.removeHandler(channel)
        }
      })
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
        backend
          .stop()
          .then(() => {
            canQuit = true
            app.quit()
          })
          .catch(() => {
            isClosing = false
            const t = backend.translate()
            dialog.showErrorBox(t('app.cleanupFailedTitle'), t('app.cleanupFailed'))
          })
      })
      createWindow(backend)
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          createWindow(backend)
        }
      })
    })
    .catch((error: unknown) => {
      if (!(error instanceof BackendStartError)) {
        console.error('Failed to open desktop window', error)
        app.exit(1)
        return
      }
      console.error('Failed to initialize desktop application', {
        stage: error.stage,
        ...error.operationError,
        systemCode: error.systemCode,
      })
      dialog.showErrorBox(error.title, error.message)
      app.exit(1)
    })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
