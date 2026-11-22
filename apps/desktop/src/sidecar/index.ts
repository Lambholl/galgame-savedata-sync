import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { BackendStartError, startBackend } from '../backend/backend.ts'
import type { DesktopBackend } from '../backend/backend.ts'
import { parseHostMessage } from './protocol.ts'
import type { HostRequest, SidecarToHostMessage } from './protocol.ts'

// 命令行：--data-dir <应用私有数据目录> [--languages <逗号分隔的系统语言>]
// 和宿主的消息格式见 protocol.ts。

// stdout 只能写协议消息；依赖库或调试代码写到 console.log 的内容改写到 stderr，免得破坏消息流。
console.log = console.error
console.info = console.error
console.debug = console.error

const INTERNAL_ERROR = {
  status: 'error',
  error: {
    code: 'internal-error',
    message: 'The desktop service failed to handle the request.',
    canRetry: false,
  },
} as const

function send(message: SidecarToHostMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

/** 写完 stdout 里排队的消息后以 code 退出。 */
function exitAfterFlush(code: number): void {
  process.stdout.write('', () => process.exit(code))
}

function exitOnUnexpectedError(error: unknown): void {
  console.error('Desktop service stopped unexpectedly', error)
  process.exit(1)
}

let nextHostRequestId = 0
const pendingHostRequests = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>()

function requestHost(request: HostRequest): Promise<unknown> {
  const id = nextHostRequestId++
  return new Promise((resolve, reject) => {
    pendingHostRequests.set(id, { resolve, reject })
    send({ type: 'host-request', id, ...request })
  })
}

const { values } = parseArgs({
  options: { 'data-dir': { type: 'string' }, languages: { type: 'string' } },
  strict: true,
})
const dataDirectory = values['data-dir']
if (!dataDirectory) {
  console.error('Missing --data-dir')
  process.exit(2)
}
const systemLanguages = (values.languages ?? '').split(',').filter(Boolean)

let backend: DesktopBackend | null = null
let isShuttingDown = false

async function shutdown(): Promise<boolean> {
  if (!backend) {
    return true
  }
  try {
    await backend.stop()
    return true
  } catch {
    // backend.stop 已经记录失败原因。
    return false
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', (line) => {
  const message = parseHostMessage(line)
  if (!message) {
    console.error('Ignored a malformed host message')
    return
  }
  if (message.type === 'host-result') {
    const pending = pendingHostRequests.get(message.id)
    pendingHostRequests.delete(message.id)
    if (message.error === undefined) {
      pending?.resolve(message.value)
    } else {
      pending?.reject(new Error(message.error))
    }
  } else if (message.type === 'invoke') {
    if (!backend) {
      send({ type: 'result', id: message.id, value: INTERNAL_ERROR })
      return
    }
    backend.router.invoke(message.channel, message.args).then(
      (value) => send({ type: 'result', id: message.id, value }),
      (error: unknown) => {
        console.error('Channel handler failed', message.channel, error)
        send({ type: 'result', id: message.id, value: INTERNAL_ERROR })
      },
    )
  } else {
    if (isShuttingDown) {
      return
    }
    isShuttingDown = true
    shutdown()
      .then((isStopped) => {
        isShuttingDown = false
        if (isStopped) {
          send({ type: 'shutdown-result', id: message.id, isStopped })
          exitAfterFlush(0)
          return
        }
        const t = backend?.translate()
        send({
          type: 'shutdown-result',
          id: message.id,
          isStopped,
          ...(t ? { title: t('app.cleanupFailedTitle'), message: t('app.cleanupFailed') } : {}),
        })
      })
      .catch(exitOnUnexpectedError)
  }
})
// 宿主进程退出或崩溃时 stdin 关闭；这时没人能显示结果，停止服务后直接退出。
input.on('close', () => {
  shutdown()
    .then((isStopped) => exitAfterFlush(isStopped ? 0 : 1))
    .catch(exitOnUnexpectedError)
})

startBackend({
  dataDirectory,
  systemLanguages,
  host: {
    chooseDirectory: async (title) => {
      const value = await requestHost({ method: 'chooseDirectory', params: { title } })
      if (value !== null && typeof value !== 'string') {
        throw new Error('The host returned an invalid directory path.')
      }
      return value
    },
    openPath: async (path) => {
      await requestHost({ method: 'openPath', params: { path } })
    },
    setTheme: (theme) => {
      requestHost({ method: 'setTheme', params: { theme } }).catch((error: unknown) => {
        console.error('Failed to apply the window theme', error)
      })
    },
  },
}).then(
  (started) => {
    backend = started
    send({ type: 'ready', title: started.translate()('app.name') })
  },
  (error: unknown) => {
    if (error instanceof BackendStartError) {
      console.error('Failed to initialize desktop application', {
        stage: error.stage,
        ...error.operationError,
        systemCode: error.systemCode,
      })
      send({ type: 'fatal', title: error.title, message: error.message })
    } else {
      console.error('Failed to initialize desktop application', error)
    }
    exitAfterFlush(1)
  },
)
