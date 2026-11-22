import { join } from 'node:path'
import { mkdir, realpath } from 'node:fs/promises'
import { createTranslator, resolveLocale } from '@savedata-sync/shared'
import type {
  AppPreferences,
  OperationError,
  ThemePreference,
  Translate,
} from '@savedata-sync/shared'
import { ChannelRouter } from './channel-registry.ts'
import { createDirectoryAdapter } from './directory-adapter.ts'
import { registerDirectoryIpc } from './directory-ipc.ts'
import { toDirectoryError } from './directory-errors.ts'
import { createWindowsArchiveAdapter } from './archive-adapter.ts'
import { WindowsHttpService } from './http-service.ts'
import { WindowsDiscoveryAdvertiser } from './discovery-advertiser.ts'
import { HttpOperationError, toHttpError } from './http-errors.ts'
import { registerServiceIpc } from './service-ipc.ts'
import { ServicePortSettings } from './service-port-settings.ts'
import { DesktopLibrary } from './library-store.ts'
import { registerLibraryIpc } from './library-ipc.ts'
import { WindowsDiscoveryBrowser } from './discovery-browser.ts'
import { WindowsDialer } from './dialer-session.ts'
import { WindowsDialerSync } from './dialer-sync.ts'
import { WindowsSyncScanner } from './sync-scanner.ts'
import { registerDialerIpc } from './dialer-ipc.ts'
import { createWindowsBackupStore } from './backup-store.ts'
import { BACKUP_LOCATION_FILE } from './backup-location.ts'
import { registerBackupIpc } from './backup-ipc.ts'
import { WindowsSyncWriter } from './sync-writer.ts'
import { WindowsRestoreRegistry } from './restore-registry.ts'
import { InterruptedWriteStore } from './interrupted-writes.ts'
import { registerSyncIpc } from './sync-ipc.ts'
import { AppPreferencesStore } from './preferences-store.ts'
import { registerPreferencesIpc } from './preferences-ipc.ts'
import { setAsideUnreadableData } from './data-recovery.ts'
import { registerDataResetIpc } from './data-reset-ipc.ts'

/** 后端需要宿主提供的平台能力。 */
export interface DesktopHost {
  /**
   * 打开系统目录选择器。
   *
   * @param title 选择器窗口的标题。
   * @returns 选中的绝对路径；取消时返回 null。
   */
  chooseDirectory(title: string): Promise<string | null>
  /** 用系统文件管理器打开路径；打不开时 reject。 */
  openPath(path: string): Promise<void>
  /** 按主题偏好设置窗口和界面的明暗；system 表示跟随系统。 */
  setTheme(theme: ThemePreference): void
}

/** 启动后端的参数；目录都是绝对路径，不存在时创建，彼此不能相同。 */
export interface BackendOptions {
  /** 界面偏好所在的配置目录。 */
  readonly configDirectory: string
  /** 设备身份、目录登记、游戏库、端口、备份设置和中断写入标记所在的数据目录。 */
  readonly dataDirectory: string
  /** 默认备份库；用户在设置里换了位置时改用那个位置。 */
  readonly backupDirectory: string
  /** 传输缓存目录，里面的内容可以随时删除。 */
  readonly cacheDirectory: string
  /** 系统的首选语言列表，如 `['zh-CN', 'en-US']`；界面语言偏好为 system 时按它选语言。 */
  readonly systemLanguages: readonly string[]
  readonly host: DesktopHost
}

/** 已启动的后端。 */
export interface DesktopBackend {
  /** 界面通道的注册表，宿主把界面请求交给它的 invoke。 */
  readonly router: ChannelRouter
  /** 按当前语言偏好返回翻译函数。 */
  translate(): Translate
  /** 返回当前的界面偏好。 */
  preferences(): AppPreferences
  /**
   * 停止网络服务、传输、恢复和备份并释放资源。并发调用共用同一次停止。
   *
   * @throws Error 释放失败时 reject，失败原因已写入 stderr；之后可以再次调用重试。
   */
  stop(): Promise<void>
}

/** 后端启动失败；title 和 message 已按语言偏好翻译，可以直接显示给用户。 */
export class BackendStartError extends Error {
  /** 失败时所在的初始化步骤，如 `library`、`backups`。 */
  readonly stage: string
  readonly operationError: OperationError
  /** 文件系统错误码，如 `EACCES`；没有时为 null。 */
  readonly systemCode: string | null
  readonly title: string

  constructor(stage: string, operationError: OperationError, cause: unknown, t: Translate) {
    super(
      `${t(`error.code.${operationError.code}`)}\n\n${operationError.message} (${operationError.code})`,
      { cause },
    )
    this.name = 'BackendStartError'
    this.stage = stage
    this.operationError = operationError
    this.systemCode = systemErrorCode(cause)
    this.title = t('app.initializeFailedTitle')
  }
}

/** 取出文件系统错误码用于记录；没有时返回 null。 */
function systemErrorCode(error: unknown): string | null {
  let cause = error
  for (let depth = 0; depth < 8 && typeof cause === 'object' && cause !== null; depth++) {
    if ('code' in cause && typeof cause.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(cause.code)) {
      return cause.code
    }
    cause = 'cause' in cause ? cause.cause : null
  }
  return null
}

/**
 * 初始化存储目录、目录适配器、游戏库、备份、写入器和网络服务，并登记全部界面通道。
 * 网络服务在界面请求启动时才开始监听。
 *
 * @throws BackendStartError 任一步初始化失败时抛出；已经创建的服务和文件句柄不释放。
 */
export async function startBackend(options: BackendOptions): Promise<DesktopBackend> {
  const { host } = options
  let preferencesStore: AppPreferencesStore | null = null
  const translate = (): Translate =>
    createTranslator(
      resolveLocale(preferencesStore?.get().locale ?? 'system', options.systemLanguages),
    )
  let stage = 'app-data'
  try {
    // 平台提供的目录可能经过系统重定向；先解析成真实路径，再做缓存的逐段检查和包含关系检查。
    // 用户选择的存档目录仍由目录适配器独立拒绝链接和越界。
    const prepare = async (path: string): Promise<string> => {
      await mkdir(path, { recursive: true })
      return realpath(path)
    }
    const configDirectory = await prepare(options.configDirectory)
    const dataDirectory = await prepare(options.dataDirectory)
    const backupDirectory = await prepare(options.backupDirectory)
    const cacheDirectory = await prepare(options.cacheDirectory)
    stage = 'data-files'
    const files = {
      'device-identity': join(dataDirectory, 'identity.json'),
      directories: join(dataDirectory, 'directories.json'),
      library: join(dataDirectory, 'game-library.json'),
      'backup-settings': join(dataDirectory, 'backup-settings.json'),
      'backup-library': join(dataDirectory, BACKUP_LOCATION_FILE),
      'service-settings': join(dataDirectory, 'service-settings.json'),
      preferences: join(configDirectory, 'preferences.json'),
    } as const
    // 读不懂的文件先改名留在原处，下面各模块按文件不存在处理，用默认值启动。
    const resets = await setAsideUnreadableData(files)
    stage = 'directories'
    const adapter = await createDirectoryAdapter(files.directories, files['device-identity'])
    for (const path of [configDirectory, dataDirectory, cacheDirectory]) {
      adapter.excludePrivateDirectory(path)
    }
    stage = 'archive-cache'
    const archive = await createWindowsArchiveAdapter(adapter, cacheDirectory)
    stage = 'library'
    const library = new DesktopLibrary(files.library, adapter)
    await library.load()
    stage = 'backups'
    const backups = await createWindowsBackupStore(
      adapter,
      backupDirectory,
      dataDirectory,
      (projectId) =>
        library.snapshot().config.games.find((game) => game.id === projectId)?.name ?? null,
    )
    stage = 'sync-writer'
    const interruptedWrites = new InterruptedWriteStore(dataDirectory)
    const syncWriter = new WindowsSyncWriter(adapter, backups, {
      interruptedWrites,
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
    stage = 'preferences'
    const preferences = new AppPreferencesStore(files.preferences)
    await preferences.load()
    preferencesStore = preferences
    host.setTheme(preferences.get().theme)
    stage = 'service-settings'
    const portSettings = new ServicePortSettings(files['service-settings'])
    await portSettings.load()
    stage = 'services'
    const httpService = new WindowsHttpService(adapter, {
      scanSource: adapter,
      library,
      sync: { writer: syncWriter, backups, archive },
    })
    const advertiser = new WindowsDiscoveryAdvertiser()
    const restores = new WindowsRestoreRegistry({
      source: adapter,
      backups,
      writer: syncWriter,
      library,
    })
    const discoveryBrowser = new WindowsDiscoveryBrowser(adapter.deviceId)
    const dialer = new WindowsDialer(library, adapter, discoveryBrowser)
    library.attachDialer(dialer)
    const dialerSync = new WindowsDialerSync({
      dialer,
      library,
      scanner: new WindowsSyncScanner(adapter),
      archive,
      writer: syncWriter,
      backups,
      deviceId: adapter.deviceId,
    })
    dialer.attachSync(dialerSync)

    const router = new ChannelRouter()
    const chooseDirectory = (): Promise<string | null> =>
      host.chooseDirectory(translate()('game.chooseFolder'))
    registerPreferencesIpc(router, preferences, (value) => host.setTheme(value.theme))
    // 只有界面偏好在配置目录，其余数据项都在数据目录。
    registerDataResetIpc(router, resets, () =>
      host.openPath(
        resets.some((item) => item !== 'preferences') ? dataDirectory : configDirectory,
      ),
    )
    registerSyncIpc(router, httpService, dialerSync, restores, interruptedWrites)
    registerBackupIpc(
      router,
      backups,
      library,
      {
        openPath: (path) => host.openPath(path),
        chooseDirectory: () => host.chooseDirectory(translate()('backup.chooseLibrary')),
      },
      () =>
        httpService.hasRunningNetworkWork() ||
        dialerSync.hasRunningWork() ||
        restores.hasRunningWork(),
    )
    registerLibraryIpc(router, library, httpService)
    registerDialerIpc(router, dialer)
    registerDirectoryIpc(router, adapter, chooseDirectory)
    registerServiceIpc(router, adapter, httpService, {
      portSettings,
      advertiser,
      chooseTargetPath: chooseDirectory,
    })

    let stopping: Promise<void> | null = null
    const stopServices = async (): Promise<void> => {
      discoveryBrowser.stop()
      // 先停拨号方的任务：它要经连接请监听方取消，连接断开后就发不出去。
      await dialerSync.stop()
      // dialer.stop 不会 reject，后面的释放步骤总会执行。
      await dialer.stop()
      try {
        await httpService.stop()
      } finally {
        // HTTP 服务停止失败时也要撤下广播；广播的 stop 不会 reject。
        await advertiser.stop()
      }
      await restores.stop()
      await syncWriter.stop()
      // 目标任务释放成功后再关闭备份，清理失败时保留存储供重试。
      await backups.stop()
    }
    return {
      router,
      translate,
      preferences: () => preferences.get(),
      stop: () => {
        stopping ??= stopServices().catch((error: unknown) => {
          stopping = null
          console.error('Failed to release desktop resources', toHttpError(error).operationError)
          throw error
        })
        return stopping
      },
    }
  } catch (error) {
    // 各模块已有的脱敏错误必须保留，避免备份等异常被改写为通用目录错误。
    const failure =
      typeof error === 'object' && error !== null && 'operationError' in error
        ? toHttpError(error).operationError
        : toDirectoryError(error).operationError
    throw new BackendStartError(stage, failure, error, translate())
  }
}
