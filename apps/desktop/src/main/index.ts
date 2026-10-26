import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDirectoryAdapter } from './directory-adapter.ts'
import { isTrustedDirectorySender, registerDirectoryIpc } from './directory-ipc.ts'
import { toDirectoryError } from './directory-errors.ts'
import { createWindowsArchiveAdapter } from './archive-adapter.ts'
import { WindowsHttpService } from './http-service.ts'
import { toHttpError } from './http-errors.ts'
import { WindowsNewFilePublisher } from './new-file-publisher.ts'

const trustedWindows = new Set<number>()
const rendererUrl = process.env.ELECTRON_RENDERER_URL
const rendererFileUrl = new URL('../renderer/index.html', import.meta.url)
const expectedRendererUrl = rendererUrl ? new URL(rendererUrl).href : rendererFileUrl.href

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 520,
    title: '存档同步',
    webPreferences: {
      preload: fileURLToPath(new URL('../preload/index.cjs', import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  trustedWindows.add(window.webContents.id)
  const webContentsId = window.webContents.id
  window.on('closed', () => trustedWindows.delete(webContentsId))

  const loading = rendererUrl
    ? window.loadURL(rendererUrl)
    : window.loadFile(fileURLToPath(new URL('../renderer/index.html', import.meta.url)))
  loading.catch((error: unknown) => {
    console.error('Failed to load desktop renderer', error)
    dialog.showErrorBox('启动失败', '无法加载应用界面，请检查构建结果。')
  })
}

const hasInstanceLock = app.requestSingleInstanceLock()
if (!hasInstanceLock) app.quit()

if (hasInstanceLock)
  app
    .whenReady()
    .then(async () => {
      const adapter = await createDirectoryAdapter(
        join(app.getPath('userData'), 'directory-config.json'),
      )
      const archive = await createWindowsArchiveAdapter(adapter, app.getPath('userData'))
      // 网络服务由后续可信界面显式启动；应用退出须等待私有缓存和连接释放。
      const httpService = new WindowsHttpService(adapter, archive)
      // 发布适配器没有默认写授权，后续仅由可信本机操作显式 grant。
      const publisher = new WindowsNewFilePublisher(adapter)
      let canQuit = false
      let isClosing = false
      app.on('before-quit', (event) => {
        if (canQuit) return
        event.preventDefault()
        if (isClosing) return
        isClosing = true
        Promise.allSettled([httpService.stop(), publisher.stop()])
          .then((results) => {
            for (const result of results)
              if (result.status === 'rejected') throw toHttpError(result.reason)
            canQuit = true
            app.quit()
          })
          .catch((error: unknown) => {
            isClosing = false
            console.error('Failed to release desktop resources', toHttpError(error).operationError)
            dialog.showErrorBox('退出清理失败', '无法释放缓存或候选文件，请检查权限后重试退出。')
          })
      })
      const disposeDirectoryIpc = registerDirectoryIpc(ipcMain, adapter, {
        choosePath: async () => {
          const result = await dialog.showOpenDialog({
            properties: ['openDirectory', 'dontAddToRecent'],
          })
          return result.canceled ? null : (result.filePaths[0] ?? null)
        },
        isTrustedSender: (event) =>
          isTrustedDirectorySender(event, trustedWindows, expectedRendererUrl),
      })
      app.once('will-quit', disposeDirectoryIpc)
      createWindow()
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
      })
    })
    .catch((error: unknown) => {
      console.error(
        'Failed to initialize desktop application',
        toDirectoryError(error).operationError,
      )
      dialog.showErrorBox('初始化失败', '无法读取目录配置，请检查应用数据与权限。')
      app.exit(1)
    })

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
