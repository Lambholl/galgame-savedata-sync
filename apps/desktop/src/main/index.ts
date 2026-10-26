import { app, BrowserWindow, dialog, ipcMain, nativeTheme } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir, realpath } from 'node:fs/promises'
import { createDirectoryAdapter } from './directory-adapter.ts'
import { isTrustedDirectorySender, registerDirectoryIpc } from './directory-ipc.ts'
import { toDirectoryError } from './directory-errors.ts'
import { createWindowsArchiveAdapter } from './archive-adapter.ts'
import { WindowsHttpService } from './http-service.ts'
import { toHttpError } from './http-errors.ts'
import { WindowsNewFilePublisher } from './new-file-publisher.ts'
import { registerServiceIpc } from './service-ipc.ts'
import { DesktopLibrary } from './library-store.ts'
import { registerLibraryIpc } from './library-ipc.ts'

const trustedWindows = new Set<number>()
const rendererUrl = process.env.ELECTRON_RENDERER_URL
const rendererFileUrl = new URL('../renderer/index.html', import.meta.url)
const expectedRendererUrl = rendererUrl ? new URL(rendererUrl).href : rendererFileUrl.href

function createWindow(): void {
  const getBackgroundColor = (): string => (nativeTheme.shouldUseDarkColors ? '#000000' : '#f5f5f5')
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 520,
    title: '存档同步',
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
    dialog.showErrorBox('启动失败', '无法加载应用界面，请检查构建结果。')
  })
}

const hasInstanceLock = app.requestSingleInstanceLock()
if (!hasInstanceLock) app.quit()

if (hasInstanceLock)
  app
    .whenReady()
    .then(async () => {
      // 平台提供的应用私有目录可能经过系统重定向；先解析它，再执行缓存的逐段检查。
      // 用户选择的存档目录仍由目录适配器独立拒绝链接和越界。
      await mkdir(app.getPath('userData'), { recursive: true })
      const privateDirectory = await realpath(app.getPath('userData'))
      const adapter = await createDirectoryAdapter(join(privateDirectory, 'directory-config.json'))
      const archive = await createWindowsArchiveAdapter(adapter, privateDirectory)
      // 网络监听与测试根写授权均由本机界面显式发起。
      const publisher = new WindowsNewFilePublisher(adapter)
      const library = new DesktopLibrary(join(privateDirectory, 'game-library.json'), adapter)
      await library.load()
      const httpService = new WindowsHttpService(adapter, archive, { publisher, library })
      app.once(
        'will-quit',
        registerLibraryIpc(ipcMain, library, httpService, (event) =>
          isTrustedDirectorySender(event, trustedWindows, expectedRendererUrl),
        ),
      )
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
      const disposeServiceIpc = registerServiceIpc(ipcMain, adapter, httpService, publisher, {
        isTrustedSender: (event) =>
          isTrustedDirectorySender(event, trustedWindows, expectedRendererUrl),
        chooseTargetPath: async () => {
          const result = await dialog.showOpenDialog({
            title: '选择独立测试接收目录',
            properties: ['openDirectory', 'dontAddToRecent'],
          })
          const path = result.canceled ? null : (result.filePaths[0] ?? null)
          if (path === null) return null
          const confirmation = await dialog.showMessageBox({
            type: 'warning',
            title: '允许接收测试文件',
            message: '请确认这是独立测试目录',
            detail: `${path}\n\n本次运行允许在该目录及子目录中创建新文件。同名文件会拒绝接收。请勿选择真实游戏存档。`,
            buttons: ['取消', '允许接收'],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          })
          return confirmation.response === 1 ? path : null
        },
      })
      app.once('will-quit', disposeServiceIpc)
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
