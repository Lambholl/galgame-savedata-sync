// 发版前的回环检查：启动两个桌面端后端，经 127.0.0.1 双向复制一份合成存档（开备份、删除多余），
// 核对两边文件一致，再各自从复制前的备份恢复，核对文件和复制前一致。
// 用法：`pnpm release:loopback`（先构建桌面端后端再运行本脚本）。
// 两个后端的配置、数据、备份库和存档都在系统临时目录里，结束后删除；监听服务会绑定所有网卡并在局域网广播。
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { createBackupBridge } from '../apps/desktop/src/bridge/backup-bridge.ts'
import { createDialerBridge } from '../apps/desktop/src/bridge/dialer-bridge.ts'
import { createDirectoryBridge } from '../apps/desktop/src/bridge/directory-bridge.ts'
import { createLibraryBridge } from '../apps/desktop/src/bridge/library-bridge.ts'
import { createServiceBridge } from '../apps/desktop/src/bridge/service-bridge.ts'
import { createSyncBridge } from '../apps/desktop/src/bridge/sync-bridge.ts'
import { diffListings, hashTree } from './device/tree-hash.mjs'
import { findFreePort } from './free-port.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SIDECAR = join(ROOT, 'apps/desktop/out/sidecar/index.cjs')
const PREFERRED_PORT = 47800
const POLL_MS = 200
const STEP_TIMEOUT_MS = 120_000

function unwrap(step, result) {
  if (result.status !== 'success') {
    throw new Error(`${step} 失败：${JSON.stringify(result.error ?? result)}`)
  }
  return result.value
}

async function poll(step, read, isDone) {
  const deadline = Date.now() + STEP_TIMEOUT_MS
  for (;;) {
    const value = await read()
    if (isDone(value)) {
      return value
    }
    if (Date.now() > deadline) {
      throw new Error(`${step} 超时，最后状态：${JSON.stringify(value)}`)
    }
    await new Promise((done) => setTimeout(done, POLL_MS))
  }
}

/** 启动一个后端进程，返回各接口；宿主的选择目录请求总是选这个实例的 saves 文件夹。 */
async function startInstance(name, base) {
  const directories = Object.fromEntries(
    ['config', 'data', 'backups', 'cache', 'saves'].map((item) => [item, join(base, name, item)]),
  )
  await Promise.all(Object.values(directories).map((path) => mkdir(path, { recursive: true })))
  const child = spawn(
    process.execPath,
    [
      SIDECAR,
      '--config-dir',
      directories.config,
      '--data-dir',
      directories.data,
      '--backup-dir',
      directories.backups,
      '--cache-dir',
      directories.cache,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  )
  const log = []
  child.stderr.setEncoding('utf8').on('data', (text) => log.push(text))
  const pending = new Map()
  let nextId = 1
  let readiness
  const ready = new Promise((done, fail) => {
    readiness = { done, fail }
  })
  child.once('exit', (code) => {
    const error = new Error(`${name} 后端已退出（${code}）：\n${log.join('')}`)
    readiness.fail(error)
    for (const { fail } of pending.values()) {
      fail(error)
    }
  })
  function send(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line)
    if (message.type === 'ready') {
      readiness.done()
    } else if (message.type === 'fatal') {
      readiness.fail(new Error(`${name} 后端启动失败：${message.message}`))
    } else if (message.type === 'result' || message.type === 'shutdown-result') {
      const call = pending.get(message.id)
      pending.delete(message.id)
      call?.done(message.type === 'result' ? message.value : message)
    } else if (message.type === 'host-request') {
      const value = message.method === 'chooseDirectory' ? directories.saves : null
      send({ type: 'host-result', id: message.id, value })
    }
  })
  function request(message) {
    const id = nextId++
    return new Promise((done, fail) => {
      pending.set(id, { done, fail })
      send({ ...message, id })
    })
  }
  const invoke = (channel, ...args) => request({ type: 'invoke', channel, args })
  await ready
  return {
    name,
    saves: directories.saves,
    service: createServiceBridge(invoke),
    directory: createDirectoryBridge(invoke),
    library: createLibraryBridge(invoke),
    dialer: createDialerBridge(invoke),
    sync: createSyncBridge(invoke),
    backup: createBackupBridge(invoke),
    async stop() {
      const result = await request({ type: 'shutdown' })
      if (!result.isStopped) {
        throw new Error(`${name} 后端没能停止：${result.message}`)
      }
      await new Promise((done) => (child.exitCode === null ? child.once('exit', done) : done()))
    },
    kill() {
      if (child.exitCode === null) {
        child.kill()
      }
    },
  }
}

/** 按 files 写文件；路径用 `/` 分隔，以 `/` 结尾的是空目录。 */
async function writeTree(root, files) {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, ...path.split('/'))
    if (path.endsWith('/')) {
      await mkdir(target, { recursive: true })
    } else {
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content)
    }
  }
}

async function expectTree(step, root, expected) {
  const differences = diffListings(await hashTree(root), expected)
  if (differences.length > 0) {
    throw new Error(`${step}：文件和预期不一致（左边是实际）\n${differences.join('\n')}`)
  }
}

/** 去掉 listing 里不含文件的目录：备份只保存文件，恢复后只剩装着文件的目录。 */
function filesOnly(listing) {
  const paths = [...listing.keys()].filter((path) => !path.endsWith('/'))
  return new Map(
    [...listing].filter(
      ([path]) => !path.endsWith('/') || paths.some((file) => file.startsWith(path)),
    ),
  )
}

/** 从 dialer 发起一次复制，开备份、删除多余，等复制成功。 */
async function copy(dialer, gameId, listenerId, direction) {
  const step = `复制 ${direction}`
  // 新建的关联随控制通道上的目录表刷新传给 listener，listener 记下反向关联之前发起会得到 session-mismatch。
  const started = unwrap(
    step,
    await poll(
      `${step} 等待关联`,
      () => dialer.sync.startRemote(gameId, listenerId, direction),
      (result) => result.status === 'success' || result.error.code !== 'session-mismatch',
    ),
  )
  const ready = await poll(
    `${step} 生成计划`,
    async () => unwrap(step, await dialer.sync.remoteRequest()),
    (request) => request.status !== 'waiting' && request.status !== 'preparing',
  )
  if (ready.status !== 'ready') {
    throw new Error(`${step} 没有生成计划：${JSON.stringify(ready)}`)
  }
  unwrap(`${step} 读取计划`, await dialer.sync.remotePlan(started.requestId))
  unwrap(
    `${step} 确认`,
    await dialer.sync.confirmRemote(started.requestId, {
      shouldBackup: true,
      shouldDeleteExtras: true,
    }),
  )
  const done = await poll(
    step,
    async () => unwrap(step, await dialer.sync.remoteRequest()),
    (request) => ['succeeded', 'failed', 'cancelled'].includes(request.status),
  )
  if (done.status !== 'succeeded') {
    throw new Error(`${step} 没有成功：${JSON.stringify(done)}`)
  }
}

/** 用本机这个游戏唯一的一份备份恢复，等恢复成功。 */
async function restoreOnlyBackup(instance, gameId, rootId) {
  const step = `${instance.name} 恢复备份`
  const { backups } = unwrap(step, await instance.backup.list(gameId))
  if (backups.length !== 1) {
    throw new Error(`${step}：应有 1 份备份，实际 ${backups.length} 份`)
  }
  const prepared = unwrap(
    step,
    await instance.sync.prepareRestore(gameId, rootId, backups[0].backupId),
  )
  const ready = await poll(
    `${step} 生成计划`,
    async () => unwrap(step, await instance.sync.restoreState(prepared.restoreId)),
    (state) => state.status !== 'preparing',
  )
  if (ready.status !== 'ready') {
    throw new Error(`${step} 没有生成计划：${JSON.stringify(ready)}`)
  }
  const plan = unwrap(step, await instance.sync.restorePlan(prepared.restoreId))
  unwrap(step, await instance.sync.executeRestore(prepared.restoreId, plan))
  const done = await poll(
    step,
    async () => unwrap(step, await instance.sync.restoreState(prepared.restoreId)),
    (state) => !['ready', 'running'].includes(state.status),
  )
  if (done.status !== 'succeeded') {
    throw new Error(`${step} 没有成功：${JSON.stringify(done)}`)
  }
}

async function chooseRoot(instance) {
  const result = await instance.directory.chooseDirectory()
  if (result.status !== 'selected') {
    throw new Error(`${instance.name} 选择存档目录失败：${JSON.stringify(result)}`)
  }
  return result.directory.rootId
}

async function main() {
  if (!existsSync(SIDECAR)) {
    throw new Error(
      `找不到 ${relative(ROOT, SIDECAR)}，先运行 pnpm --filter @savedata-sync/desktop build`,
    )
  }
  const temporary = await realpath(tmpdir())
  const base = await mkdtemp(join(temporary, 'savedata-loopback-'))
  const instances = []
  try {
    const listener = await startInstance('listener', base)
    instances.push(listener)
    const dialer = await startInstance('dialer', base)
    instances.push(dialer)

    // 合成存档：嵌套目录、空文件、空目录、非 ASCII 名称和跨多个读写块的大文件；两边各有对方没有的文件。
    await writeTree(listener.saves, {
      'save/slot01.sav': randomBytes(4096),
      'save/slot02.sav': randomBytes(1),
      'save/空文件.dat': Buffer.alloc(0),
      'system/config.ini': 'volume=80\n',
      'system/大存档 large.bin': randomBytes(6 * 1024 * 1024 + 123),
      'empty-folder/': null,
    })
    await writeTree(dialer.saves, {
      'save/slot01.sav': randomBytes(2048),
      'save/only-on-dialer.sav': randomBytes(512),
      'dialer-only-folder/': null,
    })
    const listenerBefore = await hashTree(listener.saves)
    const dialerBefore = await hashTree(dialer.saves)

    const port = await findFreePort('127.0.0.1', PREFERRED_PORT)
    const { deviceId: listenerId } = unwrap('启动监听', await listener.service.start(port))
    const listenerRoot = await chooseRoot(listener)
    const dialerRoot = await chooseRoot(dialer)
    const listenerGame = randomUUID()
    const dialerGame = randomUUID()
    unwrap(
      'listener 添加游戏',
      await listener.library.saveGames([
        { id: listenerGame, name: '回环测试', rootId: listenerRoot, links: [] },
      ]),
    )
    unwrap('连接', await dialer.dialer.connect([`127.0.0.1:${port}`], listenerId))
    unwrap(
      'dialer 添加并关联游戏',
      await dialer.library.saveGames([
        {
          id: dialerGame,
          name: '回环测试',
          rootId: dialerRoot,
          links: [{ deviceId: listenerId, gameId: listenerGame }],
        },
      ]),
    )

    await copy(dialer, dialerGame, listenerId, 'listener-to-dialer')
    await expectTree('listener → dialer 之后', dialer.saves, await hashTree(listener.saves))
    console.log('listener → dialer：两边一致')

    await writeTree(dialer.saves, {
      'save/slot01.sav': randomBytes(3000),
      'save/new-on-dialer.sav': randomBytes(700),
    })
    await rm(join(dialer.saves, 'empty-folder'), { recursive: true })
    await copy(dialer, dialerGame, listenerId, 'dialer-to-listener')
    await expectTree('dialer → listener 之后', listener.saves, await hashTree(dialer.saves))
    console.log('dialer → listener：两边一致')

    // 每边只在被写入的那次复制前备份过一次，恢复这份备份应回到复制前的文件。
    await restoreOnlyBackup(dialer, dialerGame, dialerRoot)
    await expectTree('dialer 恢复之后', dialer.saves, filesOnly(dialerBefore))
    await restoreOnlyBackup(listener, listenerGame, listenerRoot)
    await expectTree('listener 恢复之后', listener.saves, filesOnly(listenerBefore))
    console.log('两边恢复备份：和复制前一致')

    for (const instance of instances.splice(0).reverse()) {
      await instance.stop()
    }
    console.log('回环检查通过')
  } finally {
    for (const instance of instances) {
      instance.kill()
    }
    // 只删本次在系统临时目录里建的文件夹。
    if (base.startsWith(temporary + sep)) {
      await rm(base, { recursive: true, force: true, maxRetries: 5 })
    }
  }
}

await main()
