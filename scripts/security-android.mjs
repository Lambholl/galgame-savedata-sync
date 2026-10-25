import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './local-environment.mjs';

const inventory = JSON.parse(
  readFileSync(join(REPO_ROOT, '.reports/android-dependencies.json'), 'utf8'),
);
if (!Array.isArray(inventory.packages) || inventory.packages.length === 0) {
  throw new Error(
    'Android dependency inventory is empty or invalid; regenerate it through Gradle.',
  );
}
const packages = [
  ...inventory.packages,
  { name: 'org.gradle:gradle-core', version: inventory.gradleVersion },
];
let findings = 0;
for (let offset = 0; offset < packages.length; offset += 100) {
  const batch = packages.slice(offset, offset + 100);
  const response = await fetch('https://api.osv.dev/v1/querybatch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      queries: batch.map(({ name, version }) => ({
        package: { name, ecosystem: 'Maven' },
        version,
      })),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`OSV lookup failed: HTTP ${response.status}`);
  const report = await response.json();
  if (!Array.isArray(report.results) || report.results.length !== batch.length) {
    throw new Error('Incomplete Android advisory response');
  }
  for (let i = 0; i < batch.length; i += 1) {
    for (const vulnerability of report.results[i].vulns ?? []) {
      console.error(`[FAIL] ${batch[i].name}@${batch[i].version}: ${vulnerability.id}`);
      findings += 1;
    }
  }
}
console.log(
  `Android/Maven audit: ${packages.length} resolved package versions, ${findings} known advisories.`,
);
if (findings) process.exitCode = 1;
