import { readFileSync, readdirSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { REPO_ROOT } from './local-environment.mjs'

const ignoredDirectories = new Set([
  '.git',
  '.reports',
  'node_modules',
  '.gradle',
  '.idea',
  'dist',
  'out',
  'build',
  'release',
  'coverage',
])
const textExtensions = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.xml',
  '.yml',
  '.yaml',
  '.css',
  '.html',
  '.gradle',
  '.properties',
  '.java',
  '.kt',
  '.bat',
  '.cmd',
])
const textNames = new Set(['.editorconfig', '.gitattributes', '.gitignore', '.npmrc', 'gradlew'])
const decoder = new TextDecoder('utf-8', { fatal: true })
const errors = []
let checked = 0

function checkDirectory(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (
      entry.name === 'dev.local.json' ||
      entry.name === 'local.properties' ||
      entry.name === 'keystore.properties'
    ) {
      continue
    }
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      continue
    }
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        checkDirectory(path)
      }
      continue
    }
    if (!textExtensions.has(extname(entry.name)) && !textNames.has(entry.name)) {
      continue
    }
    const label = relative(REPO_ROOT, path)
    const bytes = readFileSync(path)
    checked += 1
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      errors.push(`${label}: UTF-8 BOM`)
    }
    let text
    try {
      text = decoder.decode(bytes)
    } catch {
      errors.push(`${label}: invalid UTF-8`)
      continue
    }
    if (/\r/.test(text) && !['.bat', '.cmd'].includes(extname(entry.name))) {
      errors.push(`${label}: expected LF line endings`)
    }
    const hasControlCharacter = Array.from(text).some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 && ![9, 10, 13].includes(code)
    })
    if (text.includes('\uFFFD') || hasControlCharacter) {
      errors.push(`${label}: replacement or control character`)
    }
  }
}

checkDirectory(REPO_ROOT)
if (errors.length > 0) {
  console.error(errors.join('\n'))
  process.exitCode = 1
} else {
  console.log(`UTF-8 and line endings verified for ${checked} text files.`)
}
