// 合成测试数据和目录比对。
//
// 用法：
//   node scripts/device/test-data.mjs generate <目录> [--profile small|many|large] [--seed <整数>]
//   node scripts/device/test-data.mjs hash <目录>
//   node scripts/device/test-data.mjs compare <左目录> <右目录>
// generate 只写入不存在或空的目录；同样的 profile 和 seed 生成的内容逐字节相同。
// hash 的输出格式和 device.mjs fixture-sum 相同，可以直接 diff；compare 有差异时退出码为 1。
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { diffListings, formatListing, hashTree } from './tree-hash.mjs'

const KIB = 1024
const MIB = 1024 * KIB

// 名称覆盖空格、中日文、emoji、多个点和大小写，都是两端都能创建的名称。
const SMALL_FILES = [
  ['readme.txt', 64],
  ['empty.dat', 0],
  ['one-byte.bin', 1],
  ['save 01.sav', 4 * KIB],
  ['存档/第一章.sav', 12 * KIB],
  ['セーブ/スロット 1.dat', 8 * KIB],
  ['emoji 🎮/data.bin', 2 * KIB],
  ['dots/archive.tar.gz.bak', 3 * KIB],
  ['Case/Upper.DAT', 5 * KIB],
  ['a/b/c/d/e/deep.bin', 7 * KIB],
  ['thumb/slot01.png', 96 * KIB],
  ['large/just-over-1mib.bin', MIB + 1],
]
const SMALL_EMPTY_DIRECTORIES = ['empty-dir', 'a/b/empty-leaf']

const PROFILES = {
  small: () => ({ files: SMALL_FILES, directories: SMALL_EMPTY_DIRECTORIES }),
  many: (random) => ({
    files: Array.from({ length: 2000 }, (_value, index) => [
      `group-${String(index % 40).padStart(2, '0')}/file-${String(index).padStart(4, '0')}.dat`,
      KIB + Math.floor(random() * 7 * KIB),
    ]),
    directories: [],
  }),
  large: () => ({
    files: [
      ['big/a.bin', 100 * MIB],
      ['big/b.bin', 100 * MIB],
      ['small.txt', 128],
    ],
    directories: [],
  }),
}

// mulberry32：固定种子得到固定序列，生成的数据可以在另一台电脑上重现。
function createRandom(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function fillBytes(size, random) {
  const buffer = Buffer.allocUnsafe(size)
  let offset = 0
  while (offset + 4 <= size) {
    buffer.writeUInt32LE(Math.floor(random() * 4294967296), offset)
    offset += 4
  }
  while (offset < size) {
    buffer[offset] = Math.floor(random() * 256)
    offset += 1
  }
  return buffer
}

function parseOptions(rest) {
  const options = { profile: 'small', seed: 1 }
  for (let index = 0; index < rest.length; index += 2) {
    const [key, value] = [rest[index], rest[index + 1]]
    if (key === '--profile' && Object.hasOwn(PROFILES, value)) {
      options.profile = value
    } else if (key === '--seed' && /^[0-9]{1,9}$/.test(value ?? '')) {
      options.seed = Number(value)
    } else {
      throw new Error(`选项不对：${key} ${value ?? ''}`)
    }
  }
  return options
}

function generate(root, rest) {
  const { profile, seed } = parseOptions(rest)
  if (existsSync(root) && readdirSync(root).length > 0) {
    throw new Error(`目录不是空的：${root}`)
  }
  const random = createRandom(seed)
  const { files, directories } = PROFILES[profile](random)
  let total = 0
  for (const [path, size] of files) {
    const target = join(root, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, fillBytes(size, random))
    total += size
  }
  for (const path of directories) {
    mkdirSync(join(root, path), { recursive: true })
  }
  console.log(`${files.length} 个文件，${directories.length} 个空目录，共 ${total} 字节：${root}`)
}

const [command, first, second, ...rest] = process.argv.slice(2)
try {
  if (command === 'generate' && first) {
    generate(first, second === undefined ? rest : [second, ...rest])
  } else if (command === 'hash' && first && second === undefined) {
    process.stdout.write(formatListing(await hashTree(first)))
  } else if (command === 'compare' && first && second) {
    const differences = diffListings(await hashTree(first), await hashTree(second))
    console.log(differences.length === 0 ? '一致' : differences.join('\n'))
    process.exitCode = differences.length === 0 ? 0 : 1
  } else {
    console.error(
      '用法：test-data.mjs generate <目录> [--profile small|many|large] [--seed <整数>] | hash <目录> | compare <左目录> <右目录>',
    )
    process.exitCode = 2
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 2
}
