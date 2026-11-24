// 真机调试入口：本应用在 Android 上的安装、启停、日志、界面、测试数据、备份和 frida 都经这里调用 adb。
// 用法：node scripts/device/device.mjs <子命令> [参数]；不带参数时列出子命令。安全边界见 docs/development.md。
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDeviceEnvironment, REPO_ROOT } from '../local-environment.mjs'
import { DANGEROUS_IN_FRIDA_AGENT, findRefusal } from './adb-guard.mjs'
import {
  DIRECTORY_MARK,
  diffListings,
  formatListing,
  hashTree,
  parseListing,
} from './tree-hash.mjs'

const PACKAGE = 'io.github.galgame.savedatasync'
const ACTIVITY = `${PACKAGE}/.MainActivity`
// 测试文件只放在这里；手机上已经授权给应用的测试目录也在这下面，改名会让这些授权失效。
const FIXTURE_ROOT = '/sdcard/Download/gss-sync-test'
const BACKUP_ROOT = `/sdcard/Android/data/${PACKAGE}/files/backups`
const DEFAULT_TIMEOUT_MS = 60_000
const LONG_TIMEOUT_MS = 600_000
const DEFAULT_CDP_PORT = 9333
const MAX_FRIDA_SECONDS = 600
const FRIDA_RUNNER = fileURLToPath(new URL('./frida/attach.py', import.meta.url))
// private-push 写入前取回的原内容放在这里；.reports/ 已被 Git 忽略。
const PRIVATE_BACKUP_ROOT = join(REPO_ROOT, '.reports', 'device', 'private-before')
const PRIVATE_PATH_PATTERN = /^(shared_prefs\/[A-Za-z0-9._-]+\.xml|(files|cache)\/[A-Za-z0-9._-]+)$/
// 测试目录名；带 TEMP_PREFIX 的放在临时区，测试完可以用 fixture-rm 删除。
const NAME_PATTERN = /^(tmp\/)?[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const TEMP_PREFIX = 'tmp/'
// su 只用于启动和查找配置的 frida-server；kill 只用于暂停和恢复本应用的主进程；
// rm 只用于删除临时区里的一个目录或整个临时区。其他测试目录可能已授权给应用，删掉后授权跟着失效，所以不开放删除。
const RUN_AS_SIGNAL = new RegExp(
  `^shell run-as ${PACKAGE.replaceAll('.', '\\.')} kill -(STOP|CONT) [0-9]+$`,
)
const TEMP_REMOVE = new RegExp(
  `^shell rm -rf ${FIXTURE_ROOT}/tmp(/[A-Za-z0-9][A-Za-z0-9_-]{0,63})?$`.replaceAll('.', '\\.'),
)

class UsageError extends Error {}

// 在入口的 try 里读取，配置写错时只输出原因。
let environment
let resolvedSerial

function getSerial() {
  if (resolvedSerial) {
    return resolvedSerial
  }
  if (environment.serial) {
    resolvedSerial = environment.serial
    return resolvedSerial
  }
  const serials = runRaw(['devices'])
    .split('\n')
    .map((line) => /^(\S+)\tdevice$/.exec(line.trim())?.[1])
    .filter((serial) => serial !== undefined)
  if (serials.length !== 1) {
    throw new UsageError(
      `已连接 ${serials.length} 台设备，在 dev.local.json 的 androidSerial 或环境变量 SAVEDATA_SYNC_ADB_SERIAL 里指定序列号`,
    )
  }
  resolvedSerial = serials[0]
  return resolvedSerial
}

function getFridaServer() {
  if (!environment.fridaServer) {
    throw new UsageError(
      '在 dev.local.json 的 fridaServer 或环境变量 SAVEDATA_SYNC_FRIDA_SERVER 里写 frida-server 在手机上的路径',
    )
  }
  return environment.fridaServer
}

function fridaStartCommand() {
  // 重定向输出，否则 adb shell 会一直等后台进程的输出，直到超时。
  return `su -c '${getFridaServer()} -D >/dev/null 2>&1 </dev/null'`
}

function fridaPidCommand() {
  return `su -c 'pidof ${basename(getFridaServer())}'`
}

function allowedExactCommands() {
  const patterns = [RUN_AS_SIGNAL, TEMP_REMOVE]
  if (environment.fridaServer) {
    for (const command of [fridaStartCommand(), fridaPidCommand()]) {
      patterns.push(new RegExp(`^shell ${command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))
    }
  }
  return patterns
}

/** 不经检查直接执行 adb，只用于不针对某台设备的命令。 */
function runRaw(args) {
  const result = spawnSync(environment.adb, args, { timeout: DEFAULT_TIMEOUT_MS })
  if (result.error) {
    throw result.error
  }
  return result.stdout.toString('utf8').replaceAll('\r', '')
}

/**
 * 检查参数后对选定的设备执行 adb。
 * @returns {Buffer} 标准输出。
 */
function adbBuffer(args, { timeoutMs = DEFAULT_TIMEOUT_MS, input, allowFailure = false } = {}) {
  const refusal = findRefusal(args, allowedExactCommands())
  if (refusal) {
    throw new UsageError(`拒绝执行：${refusal}`)
  }
  const result = spawnSync(environment.adb, ['-s', getSerial(), ...args], {
    timeout: timeoutMs,
    input,
    maxBuffer: 512 * 1024 * 1024,
  })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0 && !allowFailure) {
    const message = result.stderr.toString('utf8').trim() || result.stdout.toString('utf8').trim()
    throw new Error(`adb ${args.join(' ')} 退出码 ${result.status}：${message}`)
  }
  return result.stdout
}

function adb(args, options) {
  return adbBuffer(args, options).toString('utf8').replaceAll('\r', '')
}

function print(text) {
  process.stdout.write(text.endsWith('\n') || text === '' ? text : `${text}\n`)
}

function appPid() {
  return adb(['shell', 'pidof', PACKAGE], { allowFailure: true }).trim()
}

function requireAppPid() {
  const pid = appPid()
  if (!/^[0-9]+$/.test(pid)) {
    throw new UsageError(pid === '' ? '应用没有运行' : `应用不止一个进程：${pid}`)
  }
  return pid
}

function requireInteger(value, name, max = 99_999) {
  if (!/^[0-9]{1,6}$/.test(value ?? '') || Number(value) > max) {
    throw new UsageError(`${name} 需要 0–${max} 的整数：${value ?? '<空>'}`)
  }
  return Number(value)
}

function requireName(value) {
  if (!NAME_PATTERN.test(value ?? '')) {
    throw new UsageError(
      `名称只能含字母、数字、下划线和短横线，临时区的目录写成 ${TEMP_PREFIX}<名称>：${value ?? '<空>'}`,
    )
  }
  return value
}

function requirePrivatePath(value) {
  if (!PRIVATE_PATH_PATTERN.test(value ?? '')) {
    throw new UsageError(
      `应用私有数据的路径只能是 shared_prefs/<名称>.xml、files/<名称> 或 cache/<名称>：${value ?? '<空>'}`,
    )
  }
  return value
}

function requireOutput(value, extension) {
  if (!value?.endsWith(extension)) {
    throw new UsageError(`需要 ${extension} 输出路径`)
  }
  mkdirSync(dirname(resolve(value)), { recursive: true })
  return value
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function decodeXml(text) {
  return text
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll(/&#([0-9]+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replaceAll('&amp;', '&')
}

function dumpUi() {
  const output = adb(['exec-out', 'uiautomator', 'dump', '/dev/tty'])
  const end = output.lastIndexOf('</hierarchy>')
  if (end < 0) {
    // 有的手机上 uiautomator 一直等不到界面空闲，报 could not get idle state，重试也没用。
    throw new UsageError(
      `界面结构读取失败：${output.trim().replace(/\.$/, '')}。本应用的页面改用 cdp.mjs 读取`,
    )
  }
  return output.slice(0, end + '</hierarchy>'.length)
}

// 只输出有文字或无障碍描述的节点和它的中心坐标，供 tap 使用；比整棵 XML 短得多。
function summarizeUi(xml) {
  const lines = []
  for (const match of xml.matchAll(/<node ([^>]*?)\/?>/g)) {
    const attributes = Object.fromEntries(
      [...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((item) => [item[1], decodeXml(item[2])]),
    )
    const label = [attributes.text, attributes['content-desc']].filter((value) => value).join(' | ')
    if (!label) {
      continue
    }
    const bounds = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(attributes.bounds ?? '')
    const center = bounds
      ? `${(Number(bounds[1]) + Number(bounds[3])) >> 1},${(Number(bounds[2]) + Number(bounds[4])) >> 1}`
      : '?'
    const marks = attributes.clickable === 'true' ? ' *' : ''
    lines.push(`${label}  (${center})${marks}`)
  }
  return lines.join('\n')
}

function deviceListing(directory) {
  const quoted = `'${directory}'`
  const listing = new Map()
  const directories = adb(['shell', `cd ${quoted} && find . -mindepth 1 -type d`])
  for (const line of directories.split('\n')) {
    if (line !== '') {
      listing.set(`${line.replace(/^\.\//, '')}/`, DIRECTORY_MARK)
    }
  }
  const files = adb(['shell', `cd ${quoted} && find . -type f -exec sha256sum {} +`], {
    timeoutMs: LONG_TIMEOUT_MS,
  })
  for (const [path, hash] of parseListing(files)) {
    listing.set(path, hash)
  }
  return listing
}

/**
 * @typedef {object} Command
 * @property {string} group 帮助里的分组。
 * @property {string} usage 参数写法，不含子命令名。
 * @property {string} summary 帮助里的说明。
 * @property {(args: string[]) => void | Promise<void>} run
 */

/** @type {Record<string, Command>} */
const COMMANDS = {
  devices: {
    group: '设备与应用',
    usage: '',
    summary: '列出已连接设备',
    run: () => print(runRaw(['devices', '-l'])),
  },
  state: {
    group: '设备与应用',
    usage: '',
    summary: '设备、ABI、应用进程号',
    run: () => {
      print(`device: ${getSerial()} ${adb(['get-state']).trim()}`)
      print(`abi: ${adb(['shell', 'getprop', 'ro.product.cpu.abilist']).trim()}`)
      print(`app pid: ${appPid() || '没有运行'}`)
    },
  },
  install: {
    group: '设备与应用',
    usage: '<apk>',
    summary: '覆盖安装（install -r，保留应用数据）',
    run: ([apk]) => {
      if (!apk?.endsWith('.apk') || !existsSync(apk)) {
        throw new UsageError(`需要已存在的 .apk：${apk ?? '<空>'}`)
      }
      print(adb(['install', '-r', resolve(apk)], { timeoutMs: 180_000 }))
    },
  },
  instrument: {
    group: '设备与应用',
    usage: '<类名#方法名> [键=值...]',
    summary: '运行测试包里的一个仪器测试，键=值作为 -e 参数传给测试；会重启应用',
    run: ([test, ...extras]) => {
      if (!/^[A-Za-z][A-Za-z0-9]*#[A-Za-z][A-Za-z0-9]*$/.test(test ?? '')) {
        throw new UsageError('用法：instrument <类名#方法名> [键=值...]')
      }
      const options = ['-e', 'class', `${PACKAGE}.${test}`]
      for (const extra of extras) {
        // 值经手机上的 shell 解析，包在单引号里，所以不能含单引号；显示名可以有空格和中文。
        const match = /^([A-Za-z][A-Za-z0-9]*)=([^'\n]{1,128})$/.exec(extra)
        if (!match) {
          throw new UsageError(`参数要写成 键=值，值不能含单引号：${extra}`)
        }
        options.push('-e', match[1], `'${match[2]}'`)
      }
      const runner = `${PACKAGE}.test/androidx.test.runner.AndroidJUnitRunner`
      print(
        adb(['shell', 'am', 'instrument', '-w', '-r', ...options, runner], {
          timeoutMs: LONG_TIMEOUT_MS,
        }),
      )
    },
  },
  start: {
    group: '设备与应用',
    usage: '',
    summary: '启动应用',
    run: () => print(adb(['shell', 'am', 'start', '-n', ACTIVITY])),
  },
  stop: {
    group: '设备与应用',
    usage: '',
    summary: '结束应用（am force-stop，只针对本应用）',
    run: () => print(adb(['shell', 'am', 'force-stop', PACKAGE])),
  },
  pause: {
    group: '设备与应用',
    usage: '',
    summary: '经 run-as 暂停应用主进程（SIGSTOP），模拟系统冻结；只限调试版',
    run: () => {
      const pid = requireAppPid()
      adb(['shell', 'run-as', PACKAGE, 'kill', '-STOP', pid])
      print(`paused ${pid}`)
    },
  },
  resume: {
    group: '设备与应用',
    usage: '',
    summary: '经 run-as 恢复被 pause 暂停的主进程（SIGCONT）',
    run: () => {
      const pid = requireAppPid()
      adb(['shell', 'run-as', PACKAGE, 'kill', '-CONT', pid])
      print(`resumed ${pid}`)
    },
  },
  log: {
    group: '设备与应用',
    usage: '[行数]',
    summary: '本应用进程的日志，默认 200 行',
    run: ([lines = '200']) => {
      requireInteger(lines, '行数')
      print(adb(['logcat', '-d', '-t', lines, `--pid=${requireAppPid()}`]))
    },
  },
  'app-faults': {
    group: '设备与应用',
    usage: '',
    summary: '系统保留的本应用无响应和崩溃记录',
    run: () => {
      for (const tag of ['data_app_anr', 'data_app_crash']) {
        const text = adb(['shell', 'dumpsys', 'dropbox', '--print', tag], {
          timeoutMs: 120_000,
        })
        for (const block of text.split(/^={10,}$/m)) {
          if (new RegExp(`(Process|Package): ${PACKAGE.replaceAll('.', '\\.')}`).test(block)) {
            print(`[${tag}]${block}`)
          }
        }
      }
    },
  },
  'proc-state': {
    group: '设备与应用',
    usage: '',
    summary: '系统记录的本应用进程状态',
    run: () => {
      const text = adb(['shell', 'dumpsys', 'activity', 'processes', PACKAGE])
      print(
        text
          .split('\n')
          .filter((line) =>
            /ProcessRecord|[Ff]rozen|freeze|Freezer|curProcState|setProcState|curAdj|setAdj/.test(
              line,
            ),
          )
          .map((line) => line.slice(0, 160))
          .join('\n'),
      )
    },
  },
  notif: {
    group: '设备与应用',
    usage: '',
    summary: '本应用当前的通知标题、正文和进度',
    run: () => {
      const lines = adb(['shell', 'dumpsys', 'notification', '--noredact']).split('\n')
      const output = []
      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index].includes('NotificationRecord') || !lines[index].includes(PACKAGE)) {
          continue
        }
        output.push(lines[index].trim().slice(0, 200))
        for (const line of lines.slice(index + 1, index + 46)) {
          if (
            /android\.(title|text|subText|progress|progressMax|progressIndeterminate)=/.test(line)
          ) {
            output.push(`  ${line.trim().slice(0, 200)}`)
          }
        }
      }
      print(output.length > 0 ? output.join('\n') : '没有通知')
    },
  },
  'free-kb': {
    group: '设备与应用',
    usage: '',
    summary: '手机内部存储的可用空间（KB）',
    run: () =>
      print(adb(['shell', 'df', '-k', '/data']).split('\n')[1]?.trim().split(/\s+/)[3] ?? ''),
  },
  'net-state': {
    group: '设备与应用',
    usage: '<电脑 IPv4>',
    summary: '手机的 IPv4 地址和 ping 电脑的结果',
    run: ([address]) => {
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address ?? '')) {
        throw new UsageError('需要电脑的 IPv4 地址')
      }
      print(
        adb(['shell', 'ip', '-4', '-o', 'addr', 'show'])
          .split('\n')
          .filter((line) => line !== '')
          .map((line) =>
            line
              .split(/\s+/)
              .filter((part, index) => index === 1 || index === 3)
              .join(' '),
          )
          .join('\n'),
      )
      print(
        adb(['shell', 'ping', '-c', '2', '-W', '2', address], { allowFailure: true })
          .trim()
          .split('\n')
          .slice(-2)
          .join('\n'),
      )
    },
  },
  'ui-text': {
    group: '界面',
    usage: '',
    summary: '当前界面上的文字和中心坐标（* 表示可点按），代替截图查看界面',
    run: () => print(summarizeUi(dumpUi())),
  },
  'ui-dump': {
    group: '界面',
    usage: '',
    summary: '当前界面的完整结构（uiautomator XML）',
    run: () => print(dumpUi()),
  },
  screenshot: {
    group: '界面',
    usage: '<输出.png>',
    summary: '截屏到电脑',
    run: ([output]) => {
      writeFileSync(requireOutput(output, '.png'), adbBuffer(['exec-out', 'screencap', '-p']))
      print(output)
    },
  },
  tap: {
    group: '界面',
    usage: '<x> <y>',
    summary: '点按',
    run: ([x, y]) => {
      requireInteger(x, 'x')
      requireInteger(y, 'y')
      adb(['shell', 'input', 'tap', x, y])
    },
  },
  back: {
    group: '界面',
    usage: '',
    summary: '返回键',
    run: () => adb(['shell', 'input', 'keyevent', 'KEYCODE_BACK']),
  },
  home: {
    group: '界面',
    usage: '',
    summary: '回到桌面，应用留在后台',
    run: () => adb(['shell', 'input', 'keyevent', 'KEYCODE_HOME']),
  },
  wake: {
    group: '界面',
    usage: '',
    summary: '点亮屏幕',
    run: () => adb(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']),
  },
  sleep: {
    group: '界面',
    usage: '',
    summary: '关闭屏幕',
    run: () => adb(['shell', 'input', 'keyevent', 'KEYCODE_SLEEP']),
  },
  'screen-state': {
    group: '界面',
    usage: '',
    summary: '屏幕是否点亮和前台界面',
    run: () => {
      print(
        adb(['shell', 'dumpsys', 'power'])
          .split('\n')
          .filter((line) => /mWakefulness=|mStayOn=/.test(line))
          .map((line) => line.trim())
          .join('\n'),
      )
      print(
        adb(['shell', 'dumpsys', 'activity', 'activities'])
          .split('\n')
          .filter((line) => /ResumedActivity/.test(line))
          .slice(0, 2)
          .map((line) => line.trim())
          .join('\n'),
      )
    },
  },
  'cdp-forward': {
    group: '网页调试',
    usage: `[端口，默认 ${DEFAULT_CDP_PORT}]`,
    summary: '把本应用 WebView 的调试端口转发到电脑；应用重启后要重新转发',
    run: ([port = String(DEFAULT_CDP_PORT)]) => {
      requireInteger(port, '端口', 65_535)
      adb(['forward', `tcp:${port}`, `localabstract:webview_devtools_remote_${requireAppPid()}`])
      print(`node scripts/device/cdp.mjs ${port} "return document.title"`)
    },
  },
  'cdp-unforward': {
    group: '网页调试',
    usage: `[端口，默认 ${DEFAULT_CDP_PORT}]`,
    summary: '取消转发',
    run: ([port = String(DEFAULT_CDP_PORT)]) => {
      requireInteger(port, '端口', 65_535)
      adb(['forward', '--remove', `tcp:${port}`], { allowFailure: true })
    },
  },
  'private-ls': {
    group: '应用私有数据（只限调试版，经 run-as）',
    usage: '',
    summary: '列出 shared_prefs、files 和 cache 下的文件',
    run: () =>
      print(
        adb(['shell', 'run-as', PACKAGE, 'ls', '-la', 'shared_prefs', 'files', 'cache'], {
          allowFailure: true,
        }),
      ),
  },
  'private-pull': {
    group: '应用私有数据（只限调试版，经 run-as）',
    usage: '<路径> <输出>',
    summary: '取回一个文件，路径如 shared_prefs/app-storage.xml',
    run: ([path, output]) => {
      requirePrivatePath(path)
      if (!output) {
        throw new UsageError('用法：private-pull <路径> <输出>')
      }
      mkdirSync(dirname(resolve(output)), { recursive: true })
      const content = adbBuffer(['exec-out', 'run-as', PACKAGE, 'cat', path])
      writeFileSync(output, content)
      print(`${sha256(content)}  ${output}`)
    },
  },
  'private-push': {
    group: '应用私有数据（只限调试版，经 run-as）',
    usage: '<本地文件> <路径>',
    summary: '应用停止时写入一个文件；写入前把手机上的原内容存到 .reports/device/private-before/',
    run: ([local, path]) => {
      requirePrivatePath(path)
      if (!local || !existsSync(local) || !statSync(local).isFile()) {
        throw new UsageError(`需要已存在的本地文件：${local ?? '<空>'}`)
      }
      if (appPid() !== '') {
        throw new UsageError('应用正在运行，先 stop：运行中的应用会用内存里的数据覆盖写入的文件')
      }
      const content = readFileSync(local)
      const existing = adb(['shell', 'run-as', PACKAGE, 'ls', path], { allowFailure: true }).trim()
      if (existing === path) {
        const before = adbBuffer(['exec-out', 'run-as', PACKAGE, 'cat', path])
        const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-')
        const backup = join(PRIVATE_BACKUP_ROOT, stamp, path)
        mkdirSync(dirname(backup), { recursive: true })
        writeFileSync(backup, before)
        print(`原内容：${backup}`)
      } else {
        print('手机上原来没有这个文件')
      }
      adb(['shell', `run-as ${PACKAGE} sh -c 'cat > ${path}'`], { input: content })
      const written = adbBuffer(['exec-out', 'run-as', PACKAGE, 'cat', path])
      if (sha256(written) !== sha256(content)) {
        throw new Error(`写入后内容不一致：${path}`)
      }
      print(`${sha256(content)}  ${path}`)
    },
  },
  'fixture-push': {
    group: `测试文件（只在 ${FIXTURE_ROOT} 下）`,
    usage: '<本地目录> <名称>',
    summary: '上传为测试目录，已存在时合并覆盖',
    run: ([source, name]) => {
      requireName(name)
      if (!source || !existsSync(source) || !statSync(source).isDirectory()) {
        throw new UsageError(`本地目录不存在：${source ?? '<空>'}`)
      }
      const target = `${FIXTURE_ROOT}/${name}`
      // adb push 不传空目录，所以先在手机上建好全部子目录。
      const directories = readdirSync(source, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => relative(source, join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
      const unsafe = directories.find((path) => path.includes("'"))
      if (unsafe !== undefined) {
        throw new UsageError(`目录名不能含单引号：${unsafe}`)
      }
      const quoted = [target, ...directories.map((path) => `${target}/${path}`)]
        .map((path) => `'${path}'`)
        .join(' ')
      adb(['shell', `mkdir -p ${quoted}`])
      print(adb(['push', `${resolve(source)}/.`, `${target}/`], { timeoutMs: LONG_TIMEOUT_MS }))
    },
  },
  'fixture-ls': {
    group: `测试文件（只在 ${FIXTURE_ROOT} 下）`,
    usage: '[名称]',
    summary: '列出测试目录',
    run: ([name]) =>
      print(
        name === undefined
          ? adb(['shell', 'ls', '-la', FIXTURE_ROOT])
          : adb(['shell', 'ls', '-laR', `${FIXTURE_ROOT}/${requireName(name)}`]),
      ),
  },
  'media-ls': {
    group: `测试文件（只在 ${FIXTURE_ROOT} 下）`,
    usage: '',
    summary: '系统媒体库收录的测试目录条目：媒体类型（1 是图片，0 是不算媒体）和相对路径',
    run: () => {
      // 媒体库按实际路径记录，不认 /sdcard 这个别名，所以按测试目录的末段匹配。
      const marker = `/${FIXTURE_ROOT.split('/').slice(-2).join('/')}/`
      const output = adb([
        'shell',
        `content query --uri content://media/external/file --projection _data:media_type --where "_data LIKE '%${marker}%'"`,
      ])
      const rows = []
      for (const line of output.split('\n')) {
        const match = /_data=(\/.*), media_type=(\d+)$/.exec(line.trim())
        if (match) {
          rows.push(`${match[2]} ${match[1].slice(match[1].indexOf(marker) + marker.length)}`)
        }
      }
      print(rows.length > 0 ? rows.sort().join('\n') : output.trim())
    },
  },
  'fixture-sum': {
    group: `测试文件（只在 ${FIXTURE_ROOT} 下）`,
    usage: '<名称>',
    summary: '测试目录的清单：文件的 SHA-256 和全部子目录，格式同 test-data.mjs hash',
    run: ([name]) => print(formatListing(deviceListing(`${FIXTURE_ROOT}/${requireName(name)}`))),
  },
  'fixture-compare': {
    group: `测试文件（只在 ${FIXTURE_ROOT} 下）`,
    usage: '<名称> <本地目录>',
    summary: '比对测试目录和本机目录的文件内容与子目录（左边是手机）',
    run: async ([name, local]) => {
      requireName(name)
      if (!local || !existsSync(local) || !statSync(local).isDirectory()) {
        throw new UsageError(`本地目录不存在：${local ?? '<空>'}`)
      }
      const differences = diffListings(
        deviceListing(`${FIXTURE_ROOT}/${name}`),
        await hashTree(local),
      )
      print(differences.length === 0 ? '一致' : differences.join('\n'))
      if (differences.length > 0) {
        process.exitCode = 1
      }
    },
  },
  'fixture-rm': {
    group: `测试文件（只在 ${FIXTURE_ROOT} 下）`,
    usage: `<${TEMP_PREFIX}名称|tmp>`,
    summary: '删除临时区里的一个测试目录，写 tmp 时删除整个临时区；临时区以外的测试目录不能删',
    run: ([name]) => {
      if (name !== 'tmp' && !requireName(name).startsWith(TEMP_PREFIX)) {
        throw new UsageError(`只能删除临时区的目录（${TEMP_PREFIX}<名称>）或整个临时区（tmp）`)
      }
      adb(['shell', 'rm', '-rf', `${FIXTURE_ROOT}/${name}`])
      print(`已删除 ${FIXTURE_ROOT}/${name}`)
    },
  },
  'backup-ls': {
    group: '本应用的备份（只读）',
    usage: '',
    summary: '列出全部备份文件',
    run: () => print(adb(['shell', 'ls', '-laR', BACKUP_ROOT])),
  },
  'backup-sum': {
    group: '本应用的备份（只读）',
    usage: '',
    summary: '全部备份的清单，格式同 fixture-sum',
    run: () => print(formatListing(deviceListing(BACKUP_ROOT))),
  },
  'backup-json': {
    group: '本应用的备份（只读）',
    usage: '',
    summary: '输出所有 backup.json 和 in-progress.json',
    run: () =>
      print(
        adb([
          'shell',
          `cd '${BACKUP_ROOT}' && find . -mindepth 3 -maxdepth 3 -type f \\( -name backup.json -o -name in-progress.json \\) -exec sh -c 'echo "== $1"; cat "$1"; echo' _ {} \\;`,
        ]),
      ),
  },
  'frida-push': {
    group: 'frida（需要 root，root 只用于这几项）',
    usage: '<frida-server 文件>',
    summary: '把解压好的 frida-server 放到 fridaServer 配置的路径并设为可执行',
    run: ([binary]) => {
      const remote = getFridaServer()
      if (!binary || !existsSync(binary) || basename(binary) !== basename(remote)) {
        throw new UsageError(`需要本机上名为 ${basename(remote)} 的文件：${binary ?? '<空>'}`)
      }
      print(adb(['push', resolve(binary), remote], { timeoutMs: 180_000 }))
      adb(['shell', 'chmod', '755', remote])
      print(adb(['shell', 'ls', '-la', remote]))
    },
  },
  'frida-status': {
    group: 'frida（需要 root，root 只用于这几项）',
    usage: '',
    summary: 'frida-server 的进程号',
    run: () =>
      print(
        `frida-server pid: ${adb(['shell', fridaPidCommand()], { allowFailure: true }).trim() || '没有运行'}`,
      ),
  },
  'frida-start': {
    group: 'frida（需要 root，root 只用于这几项）',
    usage: '',
    summary: '启动 frida-server',
    run: () => {
      if (adb(['shell', fridaPidCommand()], { allowFailure: true }).trim() !== '') {
        throw new UsageError('frida-server 已在运行')
      }
      adb(['shell', fridaStartCommand()])
      print(
        `frida-server pid: ${adb(['shell', fridaPidCommand()], { allowFailure: true }).trim() || '没有启动'}`,
      )
    },
  },
  'frida-attach': {
    group: 'frida（需要 root，root 只用于这几项）',
    usage: `<脚本.js> [秒数，默认 30，最多 ${MAX_FRIDA_SECONDS}]`,
    summary: '用 uv 运行 frida/attach.py，把脚本附加到本应用，保持若干秒',
    run: ([agent, seconds = '30']) => {
      if (!agent?.endsWith('.js') || !existsSync(agent)) {
        throw new UsageError(`需要已存在的 .js 脚本：${agent ?? '<空>'}`)
      }
      requireInteger(seconds, '秒数', MAX_FRIDA_SECONDS)
      const source = readFileSync(agent, 'utf8')
      const dangerous = source.split('\n').findIndex((line) => DANGEROUS_IN_FRIDA_AGENT.test(line))
      if (dangerous >= 0) {
        throw new UsageError(`拒绝执行：frida 脚本第 ${dangerous + 1} 行有危险命令`)
      }
      if (adb(['shell', fridaPidCommand()], { allowFailure: true }).trim() === '') {
        throw new UsageError('先运行 frida-start')
      }
      // frida 的 Python 包和 frida-server 必须同版本，版本号取自 fridaServer 配置的文件名。
      const fridaVersion = /frida-server-([0-9.]+)-android-/.exec(getFridaServer())[1]
      const args = ['run', '--with', `frida==${fridaVersion}`, '--script', FRIDA_RUNNER]
      args.push('--serial', getSerial(), '--pid', requireAppPid())
      args.push('--script-path', resolve(agent), '--seconds', seconds)
      // 首次运行或换 frida 版本时 uv 要下载 Python 依赖，超时比保持时间多留出这部分。
      const result = spawnSync('uv', args, {
        stdio: 'inherit',
        timeout: (Number(seconds) + 180) * 1000,
      })
      if (result.error) {
        throw result.error
      }
      process.exitCode = result.status ?? 1
    },
  },
  'guard-check': {
    group: '检查',
    usage: '<文本...>',
    summary: '只检查文本作为 adb 参数时会不会被拒绝，不连接设备',
    run: (args) => print(findRefusal(args, allowedExactCommands()) ?? '通过'),
  },
}

function printUsage() {
  let group
  for (const [name, command] of Object.entries(COMMANDS)) {
    if (command.group !== group) {
      group = command.group
      print(group)
    }
    print(`  ${`${name} ${command.usage}`.padEnd(34)}${command.summary}`)
  }
}

const [name, ...args] = process.argv.slice(2)
if (name === undefined || name === 'help' || name === '--help' || name === '-h') {
  printUsage()
} else if (!Object.hasOwn(COMMANDS, name)) {
  console.error(`不支持的子命令：${name}（不带参数可查看列表）`)
  process.exitCode = 2
} else {
  try {
    environment = getDeviceEnvironment()
    await COMMANDS[name].run(args)
  } catch (error) {
    console.error(error instanceof UsageError ? error.message : (error?.stack ?? String(error)))
    process.exitCode = 2
  }
}
