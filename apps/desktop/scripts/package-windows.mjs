import { access, cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build, Platform, Arch } from 'electron-builder'
import { resolveAppVersion } from '../../../scripts/app-version.mjs'

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = resolve(APP_ROOT, '../..')
const TARGET_NAMES = new Set(['nsis', 'portable'])

/**
 * 把已构建的资源复制到新的私有暂存目录，打包 Windows 分发包。
 * 成功时输出产物路径；读取、复制、下载或打包失败时非零退出。
 */
async function main() {
  if (process.platform !== 'win32') {
    throw new Error('请在 Windows 上构建此安装包。')
  }
  const requestedTargets = [...new Set(process.argv.slice(2))]
  const targets = requestedTargets.length > 0 ? requestedTargets : ['nsis', 'portable']
  const invalidTargets = targets.filter((target) => !TARGET_NAMES.has(target))
  if (invalidTargets.length > 0) {
    throw new Error(`不支持的 Windows 打包目标：${invalidTargets.join('、')}`)
  }
  const metadata = JSON.parse(await readFile(join(APP_ROOT, 'package.json'), 'utf8'))
  // package.json 的 version 固定为 0.0.0，分发包的版本由 Git tag 推算，与界面显示的版本相同。
  const version = resolveAppVersion().name
  const config = JSON.parse(await readFile(join(APP_ROOT, 'electron-builder.json'), 'utf8'))
  for (const entry of ['out/main/index.js', 'out/preload/index.cjs', 'out/renderer/index.html']) {
    await access(join(APP_ROOT, entry))
  }

  const reports = join(REPO_ROOT, '.reports')
  await mkdir(reports, { recursive: true })
  const staging = await mkdtemp(join(reports, 'windows-package-'))
  await cp(join(APP_ROOT, 'out'), join(staging, 'out'), {
    recursive: true,
    force: false,
    errorOnExist: true,
  })
  await mkdir(join(staging, 'resources'))
  await cp(
    join(APP_ROOT, 'resources', 'app-icon.ico'),
    join(staging, 'resources', 'app-icon.ico'),
    {
      force: false,
      errorOnExist: true,
    },
  )
  await writeFile(
    join(staging, 'package.json'),
    JSON.stringify(
      {
        name: metadata.name,
        version,
        description: 'Windows 与 Android 局域网存档同步工具',
        type: metadata.type,
        main: metadata.main,
        dependencies: {},
      },
      null,
      2,
    ) + '\n',
    { encoding: 'utf8', flag: 'wx' },
  )
  // 空锁文件将打包器限定在暂存项目，避免向上扫描 pnpm 工作区。
  await writeFile(
    join(staging, 'package-lock.json'),
    JSON.stringify({
      name: metadata.name,
      version,
      lockfileVersion: 3,
      packages: { '': { name: metadata.name, version } },
    }) + '\n',
    { encoding: 'utf8', flag: 'wx' },
  )

  const require = createRequire(import.meta.url)
  const electronDist = join(dirname(require.resolve('electron/package.json')), 'dist')
  // 主进程和 preload 已由 electron-vite 打包；分发包无需 pnpm 工作区软链接。
  const artifacts = await build({
    projectDir: staging,
    targets: Platform.WINDOWS.createTarget(targets, Arch.x64),
    publish: 'never',
    config: {
      ...config,
      electronVersion: metadata.devDependencies.electron,
      ...(existsSync(join(electronDist, 'electron.exe')) ? { electronDist } : {}),
      directories: { ...config.directories, app: staging, output: join(APP_ROOT, 'release') },
    },
  })
  for (const artifact of artifacts) {
    console.log(artifact)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Windows 打包失败。')
  process.exitCode = 1
})
