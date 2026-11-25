import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exec as pkg } from '@yao-pkg/pkg'
import { NtExecutable, NtExecutableResource, Resource } from 'resedit'
import { resolveAppVersion } from '../../../scripts/app-version.mjs'

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SIDECAR_BUNDLE = join(APP_ROOT, 'out', 'sidecar', 'index.cjs')
/** Tauri `bundle.externalBin` 登记的 sidecar 路径，相对 `src-tauri`，不含目标三元组和扩展名。 */
export const SIDECAR_EXTERNAL_BIN = 'binaries/savedata-sync-backend'
const TARGET_TRIPLE = 'x86_64-pc-windows-msvc'
/** 内嵌的 Node 主版本；具体版本由 `@yao-pkg/pkg` 固定的 pkg-fetch 决定。 */
const NODE_RANGE = 'node22'

// pkg-fetch 的版本由 pkg 固定，从 pkg 的位置解析，保证下载的基础二进制和 pkg 期望的一致。
const pkgFetch = createRequire(createRequire(import.meta.url).resolve('@yao-pkg/pkg'))(
  '@yao-pkg/pkg-fetch',
)
const fetchBaseBinary = pkgFetch.need

/**
 * 返回打包时内嵌的 Node 版本，即 pkg-fetch 为 NODE_RANGE 选定的预编译版本。
 *
 * @returns {string} 形如 `22.23.5`，不带 v 前缀。
 */
export function embeddedNodeVersion() {
  return pkgFetch.getNodeVersion(NODE_RANGE).replace(/^v/, '')
}

/**
 * 用 `@yao-pkg/pkg` 把 `out/sidecar/index.cjs` 打成 Windows x64 sidecar 可执行文件，
 * 写到 `src-tauri/binaries/savedata-sync-backend-x86_64-pc-windows-msvc.exe`，已有文件被覆盖。
 * 内嵌 pkg-fetch 预编译的 Node（只带英文区域数据），文件说明、产品名和版本号换成本应用的，图标保留 Node 的。
 *
 * @param {string} version 数字版本号，形如 `0.5.0`。
 * @returns {Promise<string>} 生成的可执行文件路径。
 * @throws {Error} 不在 Windows x64 上运行、sidecar 尚未构建，或者下载基础二进制、改写资源、打包失败。
 */
export async function buildSidecarExecutable(version) {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('The sidecar executable can only be built on Windows x64.')
  }
  const output = join(APP_ROOT, 'src-tauri', `${SIDECAR_EXTERNAL_BIN}-${TARGET_TRIPLE}.exe`)
  const workDirectory = await mkdtemp(join(tmpdir(), 'savedata-sync-pkg-'))
  try {
    // forceFetch：预编译文件不存在时报错，不从源码编译 Node。下载的文件按 pkg-fetch 登记的哈希校验。
    const fetched = await fetchBaseBinary({
      nodeRange: NODE_RANGE,
      platform: 'win',
      arch: 'x64',
      forceFetch: true,
    })
    const baseBinary = join(workDirectory, 'node.exe')
    await writeFile(baseBinary, rewriteVersionInfo(await readFile(fetched), version), {
      flag: 'wx',
    })
    // pkg 在 PKG_NODE_PATH 有值时直接用这个基础二进制，不再按哈希校验，改过版本信息的副本才能用上。
    const previousNodePath = process.env.PKG_NODE_PATH
    process.env.PKG_NODE_PATH = baseBinary
    try {
      const packed = join(workDirectory, 'sidecar.exe')
      await pkg({ input: SIDECAR_BUNDLE, targets: [`${NODE_RANGE}-win-x64`], output: packed })
      await mkdir(dirname(output), { recursive: true })
      await copyFile(packed, output)
    } finally {
      if (previousNodePath === undefined) {
        delete process.env.PKG_NODE_PATH
      } else {
        process.env.PKG_NODE_PATH = previousNodePath
      }
    }
  } finally {
    await rm(workDirectory, { recursive: true, force: true })
  }
  return output
}

/**
 * 替换 Node 可执行文件的版本信息，返回新的文件内容。
 *
 * @param {Buffer} nodeExecutable Node 可执行文件的内容。
 * @param {string} version 数字版本号，形如 `0.5.0`。
 * @returns {Buffer}
 */
function rewriteVersionInfo(nodeExecutable, version) {
  const executable = NtExecutable.from(nodeExecutable, { ignoreCert: true })
  const resource = NtExecutableResource.from(executable)
  for (const versionInfo of Resource.VersionInfo.fromEntries(resource.entries)) {
    for (const language of versionInfo.getAllLanguagesForStringValues()) {
      // 保留 Node 的版权声明（MIT 许可要求），其余字段换成本应用的。
      const { LegalCopyright: legalCopyright } = versionInfo.getStringValues(language)
      versionInfo.removeAllStringValues(language, false)
      versionInfo.setStringValues(language, {
        FileDescription: 'Savedata Sync Backend',
        ProductName: 'Savedata Sync',
        InternalName: 'savedata-sync-backend',
        OriginalFilename: 'savedata-sync-backend.exe',
        ...(legalCopyright ? { LegalCopyright: legalCopyright } : {}),
      })
    }
    versionInfo.setFileVersion(`${version}.0`)
    versionInfo.setProductVersion(`${version}.0`)
    versionInfo.outputToResourceEntries(resource.entries)
  }
  resource.outputResource(executable)
  return Buffer.from(executable.generate())
}

/**
 * 返回发布 tag 推算出的数字版本号（去掉开发版的构建元数据）。
 *
 * @returns {string} 形如 `0.5.0`。
 */
export function resolveNumericVersion() {
  return resolveAppVersion().name.split('+')[0] ?? '0.0.0'
}

// 直接运行时按当前版本生成 sidecar 可执行文件。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildSidecarExecutable(resolveNumericVersion()).then(
    (output) => console.log(output),
    (error) => {
      console.error(error instanceof Error ? error.message : error)
      process.exitCode = 1
    },
  )
}
