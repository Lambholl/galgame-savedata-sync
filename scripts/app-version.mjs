import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** 发布 tag：每段 0–999，不带前导零，也不带预发布后缀。 */
const RELEASE_TAG = /^v(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/
/** `git describe --long --dirty` 的输出，例如 v0.3.0-12-gcfb3753-dirty。 */
const DESCRIBE_OUTPUT =
  /^(v(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2}))-(\d+)-g([0-9a-f]+)(-dirty)?$/

/** 找不到发布 tag（没有 git、浅克隆没拉 tag、源码压缩包）时的版本。 */
export const UNKNOWN_APP_VERSION = Object.freeze({ name: '0.0.0+unknown', code: 1 })

/**
 * 把发布 tag 转成版本。
 * versionCode = major * 1_000_000 + minor * 1_000 + patch，随版本号单调增大，最大 999_999_999，
 * 低于 Android 的上限 2_100_000_000。
 * @param {string} tag 形如 v0.3.0 的 tag 名。
 * @returns {{ name: string, code: number } | null} 版本名不带 v；tag 不是发布格式时返回 null。
 */
export function parseReleaseTag(tag) {
  const match = RELEASE_TAG.exec(tag)
  if (!match) {
    return null
  }
  const [major, minor, patch] = match.slice(1).map(Number)
  return {
    name: `${major}.${minor}.${patch}`,
    code: major * 1_000_000 + minor * 1_000 + patch,
  }
}

/**
 * 把 `git describe --tags --long --dirty` 的输出转成版本。
 * 正好在 tag 上且工作区干净时返回 tag 的版本；否则版本名追加 semver 构建元数据
 * `+<tag 之后的提交数>.g<提交哈希>[.d]`（`.d` 表示工作区有未提交的改动），versionCode 与 tag 相同。
 * @param {string} output describe 的一行输出。
 * @returns {{ name: string, code: number } | null} 输出格式不符时返回 null。
 */
export function parseDescribeOutput(output) {
  const match = DESCRIBE_OUTPUT.exec(output.trim())
  const release = match ? parseReleaseTag(match[1] ?? '') : null
  if (!match || !release) {
    return null
  }
  const [, , commits, hash, dirty] = match
  if (commits === '0' && !dirty) {
    return release
  }
  // versionCode 沿用 tag 的值，开发版和同一 tag 的正式版可以用同一把密钥互相覆盖安装。
  return { name: `${release.name}+${commits}.g${hash}${dirty ? '.d' : ''}`, code: release.code }
}

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim()
}

/**
 * 计算本次构建的版本。
 * 环境变量 RELEASE_TAG 有值时返回这个 tag 的版本；没有时用最近的发布 tag 推算开发版。
 * @param {{ env?: NodeJS.ProcessEnv, cwd?: string }} [options] 默认读取 process.env，在仓库根目录运行 git。
 * @returns {{ name: string, code: number }} 版本名和 Android versionCode；找不到 tag 或 git 不可用时为 UNKNOWN_APP_VERSION。
 * @throws {Error} RELEASE_TAG 不是 vX.Y.Z，或当前提交不是它指向的提交。
 */
export function resolveAppVersion({ env = process.env, cwd = REPO_ROOT } = {}) {
  const releaseTag = env.RELEASE_TAG
  if (releaseTag) {
    const release = parseReleaseTag(releaseTag)
    if (!release) {
      throw new Error(`Release tag must use v<major>.<minor>.<patch>, found "${releaseTag}".`)
    }
    const head = git(['rev-parse', 'HEAD'], cwd)
    const tagged = git(['rev-parse', `refs/tags/${releaseTag}^{commit}`], cwd)
    if (head !== tagged) {
      throw new Error(`HEAD ${head} is not the commit tagged ${releaseTag} (${tagged}).`)
    }
    return release
  }
  let output
  try {
    output = git(
      [
        'describe',
        '--tags',
        '--long',
        '--dirty',
        '--match',
        'v[0-9]*.[0-9]*.[0-9]*',
        '--exclude',
        'v*-*',
      ],
      cwd,
    )
  } catch {
    return UNKNOWN_APP_VERSION
  }
  return parseDescribeOutput(output) ?? UNKNOWN_APP_VERSION
}

// 直接运行时输出 JSON，供 Gradle 和发布工作流读取。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(resolveAppVersion()))
}
