import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { getAndroidEnvironment } from './local-environment.mjs'

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
// 测试和 sidecar 开发版靠 Node 的类型剥离直接运行 .ts；部分发行版打包的 Node 编译时去掉了这项功能。
addCheck(
  'Node.js TypeScript stripping',
  process.features.typescript ? 'ok' : 'fail',
  process.features.typescript
    ? String(process.features.typescript)
    : 'This Node.js build lacks TypeScript support; use an official build from nodejs.org',
)
for (const [name, command, isBatch] of [
  ['Git', 'git', false],
  ['pnpm', isWindows ? 'pnpm.cmd' : 'pnpm', isWindows],
]) {
  const result = getVersion(command, ['--version'], isBatch)
  addCheck(name, result.ok ? 'ok' : 'fail', result.output || `${command} could not run`)
}

// 桌面端的 Tauri 宿主用 Rust 编译；rustup 默认装在 ~/.cargo/bin，不一定在 PATH 里。
const cargo = getVersion('cargo')
addCheck(
  'Rust (cargo)',
  cargo.ok ? 'ok' : 'fail',
  cargo.ok ? cargo.output : 'Install Rust with rustup and add ~/.cargo/bin to PATH',
)

if (isWindows) {
  const rustHost = getVersion('rustc', ['-vV']).output.match(/^host:\s*(\S+)/m)?.[1]
  addCheck(
    'Rust MSVC toolchain',
    rustHost?.endsWith('-pc-windows-msvc') ? 'ok' : 'fail',
    rustHost ?? 'rustc could not run; install the stable x86_64-pc-windows-msvc toolchain',
  )
  const vswhere = join(
    process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
    'Microsoft Visual Studio',
    'Installer',
    'vswhere.exe',
  )
  const msvc = existsSync(vswhere)
    ? getVersion(vswhere, [
        '-latest',
        '-products',
        '*',
        '-requires',
        'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
        '-property',
        'installationPath',
      ])
    : { ok: false, output: '' }
  addCheck(
    'MSVC build tools',
    msvc.ok && msvc.output ? 'ok' : 'fail',
    msvc.output ||
      'Install Visual Studio Build Tools with "Desktop development with C++" and a Windows SDK',
  )
  // WebView2 运行时登记在 EdgeUpdate 的这个客户端 GUID 下，按机器安装和按用户安装分别在 HKLM 和 HKCU。
  const webViewClient = 'Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
  const webViewVersion = [
    `HKLM\\SOFTWARE\\WOW6432Node\\${webViewClient}`,
    `HKCU\\Software\\${webViewClient}`,
  ]
    .map((key) => getVersion('reg', ['query', key, '/v', 'pv']))
    .map((result) => (result.ok ? result.output.match(/pv\s+REG_SZ\s+(\S+)/)?.[1] : undefined))
    .find((version) => version && version !== '0.0.0.0')
  addCheck(
    'WebView2 Runtime',
    webViewVersion ? 'ok' : 'fail',
    webViewVersion ?? 'Install the Microsoft Edge WebView2 Runtime (Evergreen)',
  )
} else if (process.platform === 'linux') {
  const rustHost = getVersion('rustc', ['-vV']).output.match(/^host:\s*(\S+)/m)?.[1]
  addCheck(
    'Rust Linux toolchain',
    rustHost === 'x86_64-unknown-linux-gnu' ? 'ok' : 'fail',
    rustHost ?? 'rustc could not run; install the stable x86_64-unknown-linux-gnu toolchain',
  )
  // Tauri 在 Linux 上链接这几个库；它们的开发包随 libwebkit2gtk-4.1-dev 一起安装。
  const webKit = getVersion('pkg-config', [
    '--modversion',
    'webkit2gtk-4.1',
    'javascriptcoregtk-4.1',
    'libsoup-3.0',
    'gtk+-3.0',
  ])
  addCheck(
    'WebKitGTK 4.1 development files',
    webKit.ok ? 'ok' : 'fail',
    webKit.ok
      ? webKit.output.split('\n').join(', ')
      : 'Install pkg-config, build-essential and libwebkit2gtk-4.1-dev; see docs/development.md',
  )
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
