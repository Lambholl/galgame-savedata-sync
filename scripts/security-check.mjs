import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { REPO_ROOT } from './local-environment.mjs'
import { embeddedNodeVersion } from '../apps/desktop/scripts/build-sidecar-exe.mjs'
import { assessNodeVersion, fetchNodeReleaseData } from './toolchain-policy.mjs'

let hasFailure = false
// 打包进安装包的 sidecar 用 pkg-fetch 选定的 Node，随应用发给用户，不达标就失败。
// 本机 Node 只运行开发工具和开发版 sidecar，不达标只提示。
try {
  const data = await fetchNodeReleaseData()
  const sidecar = assessNodeVersion(embeddedNodeVersion(), data)
  console.log(
    `${sidecar.isMet ? '[OK]' : '[FAIL]'} Node.js in the packaged desktop sidecar ${embeddedNodeVersion()}: ${sidecar.detail}`,
  )
  if (!sidecar.isMet) {
    hasFailure = true
  }
  const local = assessNodeVersion(process.versions.node, data)
  console.log(
    `${local.isMet ? '[OK]' : '[WARN]'} Local Node.js ${process.version}: ${local.detail}`,
  )
} catch (error) {
  console.error('[FAIL] Node.js release lookup did not complete:', error)
  hasFailure = true
}

const isWindows = process.platform === 'win32'
const command = isWindows ? 'cmd.exe' : 'pnpm'
const prefix = isWindows ? ['/d', '/c', 'pnpm.cmd'] : []
const audit = spawnSync(
  command,
  [...prefix, 'audit', '--registry=https://registry.npmjs.org', '--audit-level', 'low'],
  {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: { ...process.env, npm_config_fetch_retries: '0', npm_config_fetch_timeout: '30000' },
  },
)
if (audit.error || audit.status !== 0) {
  hasFailure = true
}

// 包管理器是工具链的一部分，默认 npm 依赖树审计不会包含它。
const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
const pnpmVersion = manifest.packageManager.split('@').at(-1)
try {
  const response = await fetch('https://api.osv.dev/v1/querybatch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      queries: [{ package: { name: 'pnpm', ecosystem: 'npm' }, version: pnpmVersion }],
    }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    throw new Error(`OSV HTTP ${response.status}`)
  }
  const report = await response.json()
  if (!Array.isArray(report.results) || report.results.length !== 1) {
    throw new Error('Invalid OSV response')
  }
  const vulnerabilities = report.results[0].vulns ?? []
  console.log(
    `${vulnerabilities.length ? '[FAIL]' : '[OK]'} pnpm ${pnpmVersion}: ${vulnerabilities.length} OSV advisories`,
  )
  if (vulnerabilities.length) {
    hasFailure = true
  }
} catch (error) {
  console.error('[FAIL] Package manager advisory lookup did not complete:', error)
  hasFailure = true
}

console.log(
  'Android/Maven dependencies are checked separately after Gradle resolution; this command does not cover system JDK/SDK binaries.',
)
if (hasFailure) {
  process.exitCode = 1
}
