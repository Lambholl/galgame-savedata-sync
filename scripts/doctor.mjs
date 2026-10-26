import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { getAndroidEnvironment, REPO_ROOT } from './local-environment.mjs'
import { isNodeSecurityBaselineMet } from './toolchain-policy.mjs'

const isWindows = process.platform === 'win32'
const isDesktopOnly = process.argv.includes('--desktop')
const checks = []

function addCheck(name, status, detail) {
  checks.push({ name, status, detail })
}

function getVersion(command, args = ['--version'], isBatch = false) {
  const result =
    isWindows && isBatch
      ? spawnSync('cmd.exe', ['/d', '/c', command, ...args], { encoding: 'utf8', timeout: 15_000 })
      : spawnSync(command, args, { encoding: 'utf8', timeout: 15_000 })
  return {
    ok: result.status === 0,
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim(),
  }
}

function listDirectory(path) {
  return existsSync(path) ? readdirSync(path) : []
}

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number)
const isNodeSupported = (nodeMajor === 22 && nodeMinor >= 13) || nodeMajor >= 24
addCheck('Node.js', isNodeSupported ? 'ok' : 'fail', `${process.version}; requires 22.13+ or 24+`)
addCheck(
  'Node.js security patch',
  isNodeSecurityBaselineMet(process.versions.node) ? 'ok' : 'warn',
  'Use Node 22.23.4+ (22.x) or 24.22.1+ (24.x); security:check rejects older patches',
)
for (const [name, command, isBatch] of [
  ['Git', 'git', false],
  ['pnpm', isWindows ? 'pnpm.cmd' : 'pnpm', isWindows],
]) {
  const result = getVersion(command, ['--version'], isBatch)
  addCheck(name, result.ok ? 'ok' : 'fail', result.output || `${command} could not run`)
}

try {
  const requireDesktop = createRequire(join(REPO_ROOT, 'apps/desktop/package.json'))
  const electronRoot = dirname(requireDesktop.resolve('electron/package.json'))
  const pathFile = join(electronRoot, 'path.txt')
  const executable = existsSync(pathFile) ? readFileSync(pathFile, 'utf8').trim() : ''
  const electronPath = executable ? join(electronRoot, 'dist', executable) : ''
  addCheck(
    'Electron binary',
    electronPath && existsSync(electronPath) ? 'ok' : 'fail',
    electronPath ||
      'Electron runtime not downloaded; run pnpm --filter @savedata-sync/desktop exec electron --version',
  )
} catch {
  addCheck('Electron binary', 'fail', 'Run pnpm install; Electron installation must finish')
}

if (!isDesktopOnly) {
  const { sdkRoot, javaHome, studioPath } = getAndroidEnvironment()
  const java = javaHome ? join(javaHome, 'bin', isWindows ? 'java.exe' : 'java') : 'java'
  const javac = javaHome ? join(javaHome, 'bin', isWindows ? 'javac.exe' : 'javac') : 'javac'
  const javaVersion = getVersion(java)
  const javacVersion = getVersion(javac)
  const major = Number(javaVersion.output.match(/(?:openjdk|java|version)\s+"?(\d+)/i)?.[1])
  addCheck(
    'JDK',
    javaVersion.ok && javacVersion.ok && major >= 21 && major <= 24 ? 'ok' : 'fail',
    `${javaHome ?? 'PATH'}; ${javaVersion.output || 'java failed'}; ${javacVersion.output || 'javac failed'}; requires JDK 21-24`,
  )
  const pathJava = getVersion('java')
  if (major === 21) {
    const patch = Number(javaVersion.output.match(/21\.0\.(\d+)/)?.[1])
    addCheck(
      'JDK 21 security patch',
      patch >= 13 ? 'ok' : 'warn',
      'Use the current JDK 21 security patch (21.0.13+ as of 2026-10-25)',
    )
  }
  if (!pathJava.ok && javaVersion.ok) {
    addCheck(
      'Java on PATH',
      'warn',
      'PATH java is broken; scripts use JAVA_HOME or dev.local.json instead',
    )
  }
  const sdkExists = Boolean(sdkRoot && existsSync(sdkRoot))
  addCheck(
    'Android SDK',
    sdkExists ? 'ok' : 'fail',
    sdkRoot ?? 'Set ANDROID_HOME or dev.local.json androidSdk',
  )
  const hasPlatform =
    sdkExists && existsSync(join(sdkRoot, 'platforms', 'android-36', 'android.jar'))
  addCheck(
    'Android SDK Platform 36',
    hasPlatform ? 'ok' : 'fail',
    'Required by the Capacitor 8 Android project',
  )
  const buildTools = sdkExists ? listDirectory(join(sdkRoot, 'build-tools')) : []
  const hasBuildTools = buildTools.some(
    (version) =>
      Number(version.split('.')[0]) >= 35 &&
      existsSync(join(sdkRoot, 'build-tools', version, isWindows ? 'aapt2.exe' : 'aapt2')),
  )
  addCheck(
    'Android Build Tools',
    hasBuildTools ? 'ok' : 'fail',
    buildTools.join(', ') || 'Install Build Tools 35.0.0 or newer',
  )
  const adbPath = sdkExists ? join(sdkRoot, 'platform-tools', isWindows ? 'adb.exe' : 'adb') : ''
  addCheck(
    'Android Platform Tools',
    adbPath && existsSync(adbPath) ? 'ok' : 'warn',
    'Needed for USB debugging and device installation',
  )
  const commandTools = sdkExists ? listDirectory(join(sdkRoot, 'cmdline-tools')) : []
  const hasSdkManager = commandTools.some((version) =>
    existsSync(
      join(sdkRoot, 'cmdline-tools', version, 'bin', isWindows ? 'sdkmanager.bat' : 'sdkmanager'),
    ),
  )
  addCheck(
    'Android SDK Command-line Tools',
    hasSdkManager ? 'ok' : 'warn',
    'Install via Android Studio SDK Manager to manage SDK packages from CLI',
  )
  addCheck(
    'Android Studio',
    studioPath ? 'ok' : 'warn',
    studioPath ??
      'Not detected; install 2025.2.1+ or set dev.local.json androidStudio to studio64.exe',
  )
}

const report = { target: isDesktopOnly ? 'desktop' : 'desktop-and-android', checks }
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2))
} else {
  for (const check of checks) {
    console.log(`[${check.status.toUpperCase()}] ${check.name}: ${check.detail}`)
  }
  console.log('\nThis checks installed tools; it does not prove an APK builds or runs on a device.')
}
if (checks.some((check) => check.status === 'fail')) {
  process.exitCode = 1
}
