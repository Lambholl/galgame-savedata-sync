import { access, cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build, Platform, Arch } from 'electron-builder'

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = resolve(APP_ROOT, '../..')

/**
 * 在新的私有暂存目录打包已构建资源；不复制工作区依赖、用户目录或测试资料。
 * 成功输出产物路径；读取、复制、下载或打包失败时非零退出，不发布或安装产物。
 */
async function main() {
  if (process.platform !== 'win32') {
    throw new Error('请在 Windows 上构建此安装包。')
  }
  const metadata = JSON.parse(await readFile(join(APP_ROOT, 'package.json'), 'utf8'))
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
  await writeFile(
    join(staging, 'package.json'),
    JSON.stringify(
      {
        name: metadata.name,
        version: metadata.version,
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
      version: metadata.version,
      lockfileVersion: 3,
      packages: { '': { name: metadata.name, version: metadata.version } },
    }) + '\n',
    { encoding: 'utf8', flag: 'wx' },
  )

  const require = createRequire(import.meta.url)
  const electronDist = join(dirname(require.resolve('electron/package.json')), 'dist')
  // 主进程和 preload 已由 electron-vite 打包；分发包无需 pnpm 工作区软链接。
  const artifacts = await build({
    projectDir: staging,
    targets: Platform.WINDOWS.createTarget(['nsis', 'portable'], Arch.x64),
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
