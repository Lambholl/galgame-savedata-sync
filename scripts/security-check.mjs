import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { REPO_ROOT } from './local-environment.mjs';
import { isNodeSecurityBaselineMet } from './toolchain-policy.mjs';

let hasFailure = !isNodeSecurityBaselineMet(process.versions.node);
console.log(
  `${hasFailure ? '[FAIL]' : '[OK]'} Node.js security baseline: use 22.23.4+ (22.x) or 24.22.1+ (24.x). Current: ${process.version}`,
);

const isWindows = process.platform === 'win32';
const command = isWindows ? 'cmd.exe' : 'pnpm';
const prefix = isWindows ? ['/d', '/c', 'pnpm.cmd'] : [];
const audit = spawnSync(
  command,
  [...prefix, 'audit', '--registry=https://registry.npmjs.org', '--audit-level', 'low'],
  {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: { ...process.env, npm_config_fetch_retries: '0', npm_config_fetch_timeout: '30000' },
  },
);
if (audit.error || audit.status !== 0) hasFailure = true;

// 包管理器是工具链的一部分，默认 npm 依赖树审计不会包含它。
const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
const pnpmVersion = manifest.packageManager.split('@').at(-1);
try {
  const response = await fetch('https://api.osv.dev/v1/querybatch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      queries: [{ package: { name: 'pnpm', ecosystem: 'npm' }, version: pnpmVersion }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`OSV HTTP ${response.status}`);
  const report = await response.json();
  if (!Array.isArray(report.results) || report.results.length !== 1)
    throw new Error('Invalid OSV response');
  const vulnerabilities = report.results[0].vulns ?? [];
  console.log(
    `${vulnerabilities.length ? '[FAIL]' : '[OK]'} pnpm ${pnpmVersion}: ${vulnerabilities.length} OSV advisories`,
  );
  if (vulnerabilities.length) hasFailure = true;
} catch (error) {
  console.error('[FAIL] Package manager advisory lookup did not complete:', error);
  hasFailure = true;
}

console.log(
  'Android/Maven dependencies are checked separately after Gradle resolution; this command does not cover system JDK/SDK binaries.',
);
if (hasFailure) process.exitCode = 1;
