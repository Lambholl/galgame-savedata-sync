import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { createWindowsArchiveAdapter } from '../apps/desktop/src/backend/archive-adapter.ts'
import { createDirectoryAdapter } from '../apps/desktop/src/backend/directory-adapter.ts'
import { REPO_ROOT } from './local-environment.mjs'

// 原生构建前准备 Windows 产物，构建后用 Windows 接收端检验 Java 产物；不连接设备。
const OUTPUT = join(REPO_ROOT, 'apps/mobile/android/app/build/reports/archive-interop')
const ASSETS = join(REPO_ROOT, 'apps/mobile/android/app/build/generated/archive-interop')
const DEVICE_REPORT = join(REPO_ROOT, '.reports/wp013-device')
const FIXTURE = JSON.parse(
  await readFile(join(REPO_ROOT, 'apps/desktop/test/fixtures/archive-v1.json'), 'utf8'),
)
const FIXTURE_CONTENTS = FIXTURE.contentsBase64.map((value) => Buffer.from(value, 'base64'))
const mode = process.argv[2]
assert.ok(
  ['prepare', 'verify', 'verify-device', 'verify-device-saf'].includes(mode),
  'Use prepare, verify, verify-device or verify-device-saf',
)
await mkdir(OUTPUT, { recursive: true })
const source = await createDirectoryAdapter(join(OUTPUT, 'directories.json'))
const privateDirectory = join(OUTPUT, 'private')
await mkdir(privateDirectory, { recursive: true })
const archive = await createWindowsArchiveAdapter(source, privateDirectory)

async function collect(stream) {
  const chunks = []
  for await (const chunk of stream) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function unwrap(result) {
  assert.equal(result.status, 'success', JSON.stringify(result))
  return result.value
}

function fileId(index) {
  return `f${String(index + 1).padStart(6, '0')}`
}

/** 接收端只用到成员的 fileId 和大小。 */
function contentFiles(sizes) {
  return sizes.map((sizeBytes, index) => ({
    fileId: fileId(index),
    entryId: `entry-${index}`,
    sizeBytes,
    modifiedAt: null,
  }))
}

async function sendNamed(rootId, names) {
  const listing = unwrap(await source.listDirectory(rootId))
  const files = names.map((name, index) => {
    const entry = listing.entries.find((item) => item.name === name)
    return {
      fileId: fileId(index),
      entryId: entry.entryId,
      sizeBytes: entry.sizeBytes,
      modifiedAt: entry.modifiedAt,
    }
  })
  const output = new PassThrough()
  const [bytes] = await Promise.all([collect(output), archive.sendFiles(rootId, files, output)])
  return bytes
}

async function receive(sizes, bytes) {
  return archive.receiveFiles(contentFiles(sizes), Readable.from([bytes]))
}

try {
  if (mode === 'prepare') {
    const root = join(OUTPUT, 'source')
    await mkdir(root, { recursive: true })
    const names = FIXTURE_CONTENTS.map((_, index) => `夹具 ${index}.sav`)
    for (const [index, name] of names.entries()) {
      await writeFile(join(root, name), FIXTURE_CONTENTS[index])
    }
    const large = Buffer.alloc(131073)
    for (let index = 0; index < large.length; index++) {
      large[index] = (index * 31 + 7) % 256
    }
    await writeFile(join(root, 'large.sav'), large)
    const rootId = unwrap(await source.registerDirectory(root)).rootId
    await mkdir(ASSETS, { recursive: true })
    // 资源用中性后缀，避免 Android 资源合并处理 .gz 后改变待验证的原始字节。
    const fixtureBytes = await sendNamed(rootId, names)
    await writeFile(join(OUTPUT, 'windows.gz'), fixtureBytes)
    await writeFile(join(ASSETS, 'windows-archive.bin'), fixtureBytes)
    const largeBytes = await sendNamed(rootId, ['large.sav'])
    await writeFile(join(OUTPUT, 'windows-large.gz'), largeBytes)
    await writeFile(join(ASSETS, 'windows-large.bin'), largeBytes)
    console.log('Windows 归档已生成，供 JVM 和设备消费。')
  } else if (mode === 'verify-device-saf') {
    // 设备导出的清单按 fileId 顺序列出每个成员的名称、大小和是否在子目录里。
    const listing = JSON.parse(await readFile(join(DEVICE_REPORT, 'saf-files.json'), 'utf8'))
    const bytes = await readFile(join(DEVICE_REPORT, 'saf.gz'))
    assert.equal(listing.length, 4)
    const staged = await receive(
      listing.map((file) => file.sizeBytes),
      bytes,
    )
    try {
      for (const [index, file] of listing.entries()) {
        assert.ok(['empty.sav', 'large.sav', '存档😀.sav'].includes(file.name))
        if (file.isNested) {
          assert.equal(file.name, 'empty.sav')
        }
        const local = file.isNested
          ? 'control.sav'
          : file.name === 'large.sav'
            ? 'large.sav'
            : file.name === 'empty.sav'
              ? 'empty.sav'
              : 'unicode.sav'
        assert.deepEqual(
          await collect(await staged.openFile(fileId(index))),
          await readFile(join(DEVICE_REPORT, local)),
        )
      }
    } finally {
      await staged.dispose()
    }
    console.log('实际 SAF → Java 归档 → Windows 解包与四份上传原文完全一致。')
  } else {
    const bytes = await readFile(
      mode === 'verify-device' ? join(DEVICE_REPORT, 'java.gz') : join(OUTPUT, 'java.gz'),
    )
    const staged = await receive(
      FIXTURE_CONTENTS.map((content) => content.length),
      bytes,
    )
    try {
      for (const [index, content] of FIXTURE_CONTENTS.entries()) {
        assert.deepEqual(await collect(await staged.openFile(fileId(index))), content)
      }
    } finally {
      await staged.dispose()
    }
    assert.deepEqual(await readdir(join(privateDirectory, 'transfer-archives-v1')), [
      'cache-root.json',
    ])
    console.log(
      `${mode === 'verify-device' ? '设备 Java' : 'JVM Java'} → Windows 解包及独立内容期望验证通过。`,
    )
  }
} finally {
  await archive.retryCleanup()
  // 只删除此脚本在固定报告目录内生成的源夹具；报告用于后续 Android 互通验证。
  if (mode === 'verify') {
    const root = join(OUTPUT, 'source')
    for (const [index] of FIXTURE_CONTENTS.entries()) {
      await unlink(join(root, `夹具 ${index}.sav`))
    }
    await unlink(join(root, 'large.sav'))
    await rmdir(root)
  }
}
