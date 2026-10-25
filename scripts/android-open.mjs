import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { getAndroidEnvironment, REPO_ROOT } from './local-environment.mjs'

const { studioPath } = getAndroidEnvironment()
if (!studioPath) {
  throw new Error(
    'Android Studio not found. Install 2025.2.1+ and set dev.local.json androidStudio.',
  )
}

const child = spawn(studioPath, [join(REPO_ROOT, 'apps', 'mobile', 'android')], {
  detached: true,
  stdio: 'ignore',
})
child.on('error', (error) => {
  console.error('Could not open Android Studio:', error)
  process.exitCode = 1
})
child.unref()
