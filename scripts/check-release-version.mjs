import { readFile } from 'node:fs/promises'

const RELEASE_TAG = /^v(\d+\.\d+\.\d+)$/
const tag = process.argv[2]
const match = tag ? RELEASE_TAG.exec(tag) : null
if (!match) {
  throw new Error('Release tag must use v<major>.<minor>.<patch>, for example v0.1.0.')
}
const expectedVersion = match[1]
const packageFiles = [
  'package.json',
  'apps/shared/package.json',
  'apps/desktop/package.json',
  'apps/mobile/package.json',
]
const packageVersions = await Promise.all(
  packageFiles.map(async (path) => ({
    path,
    version: JSON.parse(await readFile(path, 'utf8')).version,
  })),
)
const androidBuild = await readFile('apps/mobile/android/app/build.gradle', 'utf8')
const androidVersion = /versionName\s+"([^"]+)"/.exec(androidBuild)?.[1]
const versions = [
  ...packageVersions,
  { path: 'apps/mobile/android/app/build.gradle', version: androidVersion },
]
const mismatches = versions.filter((item) => item.version !== expectedVersion)
if (mismatches.length > 0) {
  for (const item of mismatches) {
    console.error(`${item.path}: expected ${expectedVersion}, found ${item.version ?? 'missing'}`)
  }
  process.exitCode = 1
} else {
  console.log(`Release ${tag} matches all project versions.`)
}
