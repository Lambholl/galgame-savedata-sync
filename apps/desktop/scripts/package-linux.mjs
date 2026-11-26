import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SIDECAR_EXTERNAL_BIN, resolveNumericVersion } from './build-sidecar-exe.mjs'

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TAURI_ROOT = join(APP_ROOT, 'src-tauri')
const RELEASE_DIRECTORY = join(APP_ROOT, 'release')

/**
 * 构建 Linux x64 的 AppImage 和 deb，输出到 `apps/desktop/release/`，同名文件被覆盖。
 * 版本号由 Git tag 推算。成功时输出产物路径；构建或打包失败时非零退出。
 */
async function main() {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error('Linux packages can only be built on Linux x64.')
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
        bundle: {
          active: true,
          targets: ['deb', 'appimage'],
          externalBin: [SIDECAR_EXTERNAL_BIN],
          category: 'Utility',
        },
      }),
      { encoding: 'utf8', flag: 'wx' },
    )
    const tauriCli = createRequire(import.meta.url).resolve('@tauri-apps/cli/tauri.js')
    execFileSync(process.execPath, [tauriCli, 'build', '--config', overridePath], {
      cwd: APP_ROOT,
      stdio: 'inherit',
    })

    await mkdir(RELEASE_DIRECTORY, { recursive: true })
    // Tauri 按 `productName_版本_amd64` 命名产物；目录里可能留着旧产品名或旧版本的产物。
    const { productName } = JSON.parse(await readFile(join(TAURI_ROOT, 'tauri.conf.json'), 'utf8'))
    const bundleDirectory = join(TAURI_ROOT, 'target', 'release', 'bundle')
    const outputs = [
      [
        join(bundleDirectory, 'appimage', `${productName}_${version}_amd64.AppImage`),
        join(RELEASE_DIRECTORY, `SavedataSync-${version}-linux-amd64.AppImage`),
      ],
      [
        join(bundleDirectory, 'deb', `${productName}_${version}_amd64.deb`),
        join(RELEASE_DIRECTORY, `SavedataSync-${version}-linux-amd64.deb`),
      ],
    ]
    // linuxdeploy 改写过的 sidecar 启动即崩溃，见 build-sidecar-exe.mjs 里设 RUNPATH 的原因。
    await verifyAppImageSidecar(outputs[0][0], workDirectory)
    for (const [source, target] of outputs) {
      await copyFile(source, target)
      console.log(target)
    }
  } finally {
    await rm(workDirectory, { recursive: true, force: true })
  }
}

/**
 * 核对 AppImage 里的 sidecar 和构建出的 sidecar 逐字节相同。
 *
 * @param {string} appImage AppImage 文件路径。
 * @param {string} workDirectory 解包用的空闲目录。
 * @returns {Promise<void>}
 * @throws {Error} 两者不同时抛出。
 */
async function verifyAppImageSidecar(appImage, workDirectory) {
  const name = basename(SIDECAR_EXTERNAL_BIN)
  // --appimage-extract 不需要 FUSE，解出的文件在当前目录的 squashfs-root 下。
  execFileSync(appImage, ['--appimage-extract', `usr/bin/${name}`], {
    cwd: workDirectory,
    stdio: 'ignore',
  })
  const packed = await readFile(join(workDirectory, 'squashfs-root', 'usr', 'bin', name))
  const built = await readFile(join(TAURI_ROOT, 'target', 'release', name))
  if (!packed.equals(built)) {
    throw new Error('The sidecar inside the AppImage was modified during bundling.')
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
