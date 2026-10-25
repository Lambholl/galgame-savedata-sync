import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Absolute checkout root; callers must keep generated project files inside it. */
export const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))

function readLocalSettings() {
  const path = join(REPO_ROOT, 'dev.local.json')
  if (!existsSync(path)) return {}
  const value = JSON.parse(readFileSync(path, 'utf8'))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('dev.local.json must contain a JSON object')
  }
  for (const key of ['androidSdk', 'javaHome', 'androidStudio']) {
    if (
      value[key] !== undefined &&
      (typeof value[key] !== 'string' || (value[key] !== '' && !isAbsolute(value[key])))
    ) {
      throw new Error(`dev.local.json: ${key} must be an absolute path or an empty string`)
    }
  }
  if (value.gradleProxy !== undefined && typeof value.gradleProxy !== 'string') {
    throw new Error('dev.local.json: gradleProxy must be an HTTP proxy URL or an empty string')
  }
  return value
}

/**
 * Resolves machine-local Android paths and an optional unauthenticated HTTP proxy for Gradle.
 * Does not change system environment variables or accept proxy credentials in the local file.
 * Local settings override environment variables. Returned paths may not exist; callers
 * must validate the tools they use. Rejects malformed dev.local.json by throwing.
 */
export function getAndroidEnvironment() {
  const settings = readLocalSettings()
  const sdkRoot =
    settings.androidSdk ||
    process.env.ANDROID_HOME ||
    process.env.ANDROID_SDK_ROOT ||
    (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Android', 'Sdk') : undefined)
  const studioCandidates = [
    settings.androidStudio,
    process.env.CAPACITOR_ANDROID_STUDIO_PATH,
    process.env.ProgramFiles
      ? join(process.env.ProgramFiles, 'Android', 'Android Studio', 'bin', 'studio64.exe')
      : undefined,
  ]
  const studioPath = studioCandidates.find((path) => path && existsSync(path))
  const bundledJava = studioPath ? join(dirname(dirname(studioPath)), 'jbr') : undefined
  const javaHome =
    settings.javaHome ||
    process.env.JAVA_HOME ||
    (bundledJava && existsSync(bundledJava) ? bundledJava : undefined)
  let gradleProxy
  if (settings.gradleProxy) {
    const proxy = new URL(settings.gradleProxy)
    const isSafeHost =
      /^[a-z0-9.-]+$/i.test(proxy.hostname) || /^\[[a-f0-9:]+\]$/i.test(proxy.hostname)
    if (proxy.protocol !== 'http:' || proxy.username || proxy.password || !isSafeHost) {
      throw new Error(
        'gradleProxy requires an HTTP endpoint without credentials and a valid hostname',
      )
    }
    gradleProxy = { host: proxy.hostname, port: Number(proxy.port || '80') }
  }
  return { sdkRoot, javaHome, studioPath, gradleProxy }
}
