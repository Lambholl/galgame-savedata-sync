import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SIDECAR_EXTERNAL_BIN, resolveNumericVersion } from './build-sidecar-exe.mjs'

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TAURI_ROOT = join(APP_ROOT, 'src-tauri')
const RELEASE_DIRECTORY = join(APP_ROOT, 'release')
/** 与 `tauri.conf.json` 的 `mainBinaryName` 一致。 */
const MAIN_EXECUTABLE = 'SavedataSync.exe'
const SIDECAR_EXECUTABLE = 'savedata-sync-backend.exe'

/**
 * 构建 Windows x64 的 NSIS 安装包和免安装 zip，输出到 `apps/desktop/release/`，同名文件被覆盖。
 * 版本号由 Git tag 推算。成功时输出产物路径；构建或打包失败时非零退出。
 */
async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('Windows packages can only be built on Windows x64.')
  }
  const version = resolveNumericVersion()
  const workDirectory = await mkdtemp(join(tmpdir(), 'savedata-sync-package-'))
  try {
    // externalBin 只在打包时登记：登记后 tauri dev 和 cargo build 也会要求 sidecar 可执行文件已经存在。
    const overridePath = join(workDirectory, 'tauri.package.json')
    await writeFile(
      overridePath,
      JSON.stringify({
        version,
        build: { beforeBuildCommand: 'pnpm build && node scripts/build-sidecar-exe.mjs' },
        bundle: { active: true, externalBin: [SIDECAR_EXTERNAL_BIN] },
      }),
      { encoding: 'utf8', flag: 'wx' },
    )
    const tauriCli = createRequire(import.meta.url).resolve('@tauri-apps/cli/tauri.js')
    execFileSync(process.execPath, [tauriCli, 'build', '--config', overridePath], {
      cwd: APP_ROOT,
      stdio: 'inherit',
    })

    await mkdir(RELEASE_DIRECTORY, { recursive: true })
    const installer = join(RELEASE_DIRECTORY, `SavedataSync-${version}-windows-amd64-setup.exe`)
    // Tauri 按 `productName_版本_x64-setup.exe` 命名安装包；目录里可能留着旧产品名或旧版本的安装包。
    const { productName } = JSON.parse(await readFile(join(TAURI_ROOT, 'tauri.conf.json'), 'utf8'))
    const bundleDirectory = join(TAURI_ROOT, 'target', 'release', 'bundle', 'nsis')
    await copyFile(join(bundleDirectory, `${productName}_${version}_x64-setup.exe`), installer)

    const portableName = `SavedataSync-${version}-windows-amd64-portable`
    const staging = join(workDirectory, portableName)
    await mkdir(staging)
    const releaseBuild = join(TAURI_ROOT, 'target', 'release')
    for (const file of [MAIN_EXECUTABLE, SIDECAR_EXECUTABLE]) {
      await copyFile(join(releaseBuild, file), join(staging, file))
    }
    const archive = join(RELEASE_DIRECTORY, `${portableName}.zip`)
    await rm(archive, { force: true })
    // 用系统自带的 bsdtar 生成 zip；Git Bash 等环境 PATH 里的 GNU tar 不支持 zip。
    const systemTar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    execFileSync(systemTar, ['-a', '-c', '-f', archive, '-C', workDirectory, portableName], {
      stdio: 'inherit',
      windowsHide: true,
    })
    console.log(installer)
    console.log(archive)
  } finally {
    await rm(workDirectory, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
