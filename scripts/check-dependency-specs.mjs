// 检查 npm 依赖的版本写法：会打包给用户的依赖（dependencies、peerDependencies）和 catalog 写精确版本，
// 开发工具（devDependencies）写 ^ 范围。规则和例外见 .project-memory/standards/coding.md。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './local-environment.mjs'

const PACKAGES = ['.', 'apps/desktop', 'apps/mobile', 'apps/shared']
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
// 和 Capacitor 运行时包同版本整组升级，不能单独被 pnpm update 带走。
const EXACT_DEV_DEPENDENCIES = new Set(['@capacitor/cli'])

const problems = []

const workspace = readFileSync(join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8')
// 只读顶层 catalog 块里两格缩进的 `名称: 版本` 行，项目没有用命名 catalog。
const catalogBlock = /^catalog:\r?\n((?: {2}.*\r?\n?)*)/m.exec(workspace)?.[1] ?? ''
for (const line of catalogBlock.split(/\r?\n/)) {
  const match = /^ {2}'?([^':]+)'?:\s*(\S+)\s*$/.exec(line)
  if (match && !EXACT.test(match[2])) {
    problems.push(`pnpm-workspace.yaml catalog ${match[1]}: ${match[2]} 要写精确版本`)
  }
}

for (const directory of PACKAGES) {
  const path = join(directory, 'package.json')
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, path), 'utf8'))
  for (const field of ['dependencies', 'peerDependencies']) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      if (!EXACT.test(spec) && spec !== 'catalog:' && !spec.startsWith('workspace:')) {
        problems.push(`${path} ${field} ${name}: ${spec} 要写精确版本或 catalog:`)
      }
    }
  }
  for (const [name, spec] of Object.entries(manifest.devDependencies ?? {})) {
    const peer = manifest.peerDependencies?.[name]
    if (peer !== undefined) {
      // 本包开发时安装的 peer 依赖，版本和 peer 声明一致。
      if (spec !== peer) {
        problems.push(
          `${path} devDependencies ${name}: ${spec} 要和 peerDependencies 的 ${peer} 相同`,
        )
      }
    } else if (EXACT_DEV_DEPENDENCIES.has(name)) {
      if (!EXACT.test(spec)) {
        problems.push(`${path} devDependencies ${name}: ${spec} 要写精确版本`)
      }
    } else if (!spec.startsWith('^')) {
      problems.push(`${path} devDependencies ${name}: ${spec} 要写 ^ 范围`)
    }
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'))
  process.exitCode = 1
} else {
  console.log('Dependency version specifiers verified.')
}
