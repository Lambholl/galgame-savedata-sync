import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { getAndroidEnvironment, REPO_ROOT } from './local-environment.mjs'

const { sdkRoot, javaHome, gradleProxy } = getAndroidEnvironment()
const isCheckstyle = process.argv.includes('--checkstyle')
// Checkstyle 只读 Java 源文件，只装了 JDK 的机器也能运行 pnpm lint。
if (
  !isCheckstyle &&
  (!sdkRoot || !existsSync(join(sdkRoot, 'platforms', 'android-36', 'android.jar')))
) {
  throw new Error('Android SDK Platform 36 missing. Run pnpm doctor and configure dev.local.json.')
}
if (
  !javaHome ||
  !existsSync(join(javaHome, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac'))
) {
  throw new Error('Configure a JDK in JAVA_HOME or dev.local.json javaHome; run pnpm doctor.')
}

const cwd = join(REPO_ROOT, 'apps', 'mobile', 'android')
const isWindows = process.platform === 'win32'
const command = isWindows ? 'cmd.exe' : './gradlew'
const isInventory = process.argv.includes('--inventory')
const isTest = process.argv.includes('--test')
const isUnitTest = process.argv.includes('--unit-test')
const isRelease = process.argv.includes('--release')
const isDevServer = process.argv.includes('--dev-server')
if (isDevServer) {
  if (isRelease) {
    throw new Error('--dev-server only builds the debug APK.')
  }
  pointWebViewAtDevServer()
}
const gradleArgs = isInventory
  ? [
      '--no-daemon',
      '--init-script',
      '../../../scripts/android-inventory.gradle',
      'writeDependencyInventory',
      '--console=plain',
    ]
  : isUnitTest
    ? // 改 Java 时会反复运行，和 Checkstyle 一样复用 Gradle 后台进程。
      [':app:testDebugUnitTest', '--console=plain']
    : isTest
      ? [
          '--no-daemon',
          ':app:testDebugUnitTest',
          ':app:lintDebug',
          ':app:assembleDebug',
          ':app:assembleDebugAndroidTest',
          // release 用 src/release 里的 FaultInjection 空实现，编译一次确认它和调试版的签名一致。
          ':app:compileReleaseJavaWithJavac',
          '--console=plain',
        ]
      : isCheckstyle
        ? // pnpm lint 经常运行，保留 Gradle 后台进程，免去每次约 17 秒的启动时间。
          // 检查前可能还没执行 android:sync，:app 缺少生成的文件时无法配置，所以只配置根项目。
          ['--configure-on-demand', ':javaCheckstyle', '--console=plain']
        : ['--no-daemon', isRelease ? ':app:assembleRelease' : ':app:assembleDebug']
// 显式相对路径：设置 NoDefaultCurrentDirectoryInExePath 时，cmd 不在当前目录查找裸名。
const args = isWindows ? ['/d', '/c', '.\\gradlew.bat', ...gradleArgs] : gradleArgs
const proxyOptions = gradleProxy
  ? `-Dhttp.proxyHost=${gradleProxy.host} -Dhttp.proxyPort=${gradleProxy.port} -Dhttps.proxyHost=${gradleProxy.host} -Dhttps.proxyPort=${gradleProxy.port}`
  : ''
const child = spawn(command, args, {
  cwd,
  stdio: 'inherit',
  env: {
    ...process.env,
    JAVA_HOME: javaHome,
    ANDROID_HOME: sdkRoot,
    ANDROID_SDK_ROOT: sdkRoot,
    GRADLE_OPTS: [process.env.GRADLE_OPTS, proxyOptions].filter(Boolean).join(' '),
  },
})
child.on('error', (error) => {
  console.error('Could not launch the project Gradle wrapper:', error)
  process.exitCode = 1
})
child.on('exit', (code) => {
  process.exitCode = code ?? 1
})

/**
 * 在 cap sync 生成的 capacitor.config.json 里写入 server.url，让 WebView 加载电脑上的 Vite 开发服务器。
 * 下一次 cap sync 重新生成这个文件，WebView 回到 APK 里的页面。
 * @throws {Error} 还没有运行过 cap sync 时。
 */
function pointWebViewAtDevServer() {
  const file = join(cwd, 'app', 'src', 'main', 'assets', 'capacitor.config.json')
  if (!existsSync(file)) {
    throw new Error('Run pnpm android:sync before building with --dev-server.')
  }
  const config = JSON.parse(readFileSync(file, 'utf8'))
  // pnpm dev:android 经 adb reverse 把手机上的这个端口接到电脑上 Vite 的实际端口；
  // 端口和 scripts/device/device.mjs 的 PHONE_DEV_SERVER_PORT 相同。
  config.server = { ...config.server, url: 'http://localhost:5173' }
  writeFileSync(file, `${JSON.stringify(config, null, '\t')}\n`)
}
