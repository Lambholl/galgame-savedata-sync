import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { getAndroidEnvironment, REPO_ROOT } from './local-environment.mjs'

const { sdkRoot, javaHome, gradleProxy } = getAndroidEnvironment()
if (!sdkRoot || !existsSync(join(sdkRoot, 'platforms', 'android-36', 'android.jar'))) {
  throw new Error(
    'Android SDK Platform 36 missing. Run pnpm env:check and configure dev.local.json.',
  )
}
if (
  !javaHome ||
  !existsSync(join(javaHome, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac'))
) {
  throw new Error('Configure a JDK in JAVA_HOME or dev.local.json javaHome; run pnpm env:check.')
}

const cwd = join(REPO_ROOT, 'apps', 'mobile', 'android')
const isWindows = process.platform === 'win32'
const command = isWindows ? 'cmd.exe' : './gradlew'
const isInventory = process.argv.includes('--inventory')
const isTest = process.argv.includes('--test')
const gradleArgs = isInventory
  ? [
      '--no-daemon',
      '--init-script',
      '../../../scripts/android-inventory.gradle',
      'writeDependencyInventory',
      '--console=plain',
    ]
  : isTest
    ? [
        '--no-daemon',
        ':app:testDebugUnitTest',
        ':app:lintDebug',
        ':app:assembleDebug',
        ':app:assembleDebugAndroidTest',
        '--console=plain',
      ]
    : ['--no-daemon', ':app:assembleDebug']
// 显式相对路径：设置 NoDefaultCurrentDirectoryInExePath 时，cmd 不在当前目录查找裸名
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
