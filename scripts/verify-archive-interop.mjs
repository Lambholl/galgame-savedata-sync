import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createWindowsArchiveAdapter } from '../apps/desktop/src/main/archive-adapter.ts'
import { createDirectoryAdapter } from '../apps/desktop/src/main/directory-adapter.ts'
import { REPO_ROOT } from './local-environment.mjs'

// 原生构建前准备 Windows 产物，构建后用 Windows receiver 检验 Java 产物；不连接设备。
const OUTPUT = join(REPO_ROOT, 'apps/mobile/android/app/build/reports/archive-interop')
const FIXTURE = JSON.parse(
  await readFile(join(REPO_ROOT, 'apps/desktop/test/fixtures/archive-v1.json'), 'utf8'),
)
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
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks)
}

try {
  if (mode === 'prepare') {
    const root = join(OUTPUT, 'source')
    await mkdir(root, { recursive: true })
    const names = FIXTURE.contentsBase64.map((_, index) => `夹具 ${index}.sav`)
    for (const [index, name] of names.entries())
      await writeFile(join(root, name), Buffer.from(FIXTURE.contentsBase64[index], 'base64'))
    const registered = await source.registerDirectory(root)
    assert.equal(registered.status, 'success')
    const listing = await source.listDirectory(registered.value.rootId)
    assert.equal(listing.status, 'success')
    const prepared = await archive.prepare({
      protocolVersion: 1,
      transferId: 'windows-interop',
      sourceRootId: registered.value.rootId,
      files: names.map((name, index) => ({
        fileId: `f${String(index + 1).padStart(6, '0')}`,
        entryId: listing.value.entries.find((entry) => entry.name === name).entryId,
      })),
    })
    try {
      const bytes = await collect(await prepared.openArchive())
      await writeFile(join(OUTPUT, 'windows.gz'), bytes)
      await writeFile(join(OUTPUT, 'windows-manifest.json'), JSON.stringify(prepared.manifest))
      const assets = join(REPO_ROOT, 'apps/mobile/android/app/build/generated/archive-interop')
      await mkdir(assets, { recursive: true })
      // 使用中性后缀，避免 Android 资源合并阶段处理 .gz 后改变待验证的原始字节。
      await writeFile(join(assets, 'windows-archive.bin'), bytes)
      await unlink(join(assets, 'windows.gz')).catch((error) => {
        if (error.code !== 'ENOENT') throw error
      })
      await writeFile(join(assets, 'windows-manifest.json'), JSON.stringify(prepared.manifest))
    } finally {
      await prepared.dispose()
    }
    const large = Buffer.alloc(131073)
    for (let index = 0; index < large.length; index++) large[index] = (index * 31 + 7) % 256
    await writeFile(join(root, 'large.sav'), large)
    const updated = await source.listDirectory(registered.value.rootId)
    assert.equal(updated.status, 'success')
    const largeArchive = await archive.prepare({
      protocolVersion: 1,
      transferId: 'windows-large',
      sourceRootId: registered.value.rootId,
      files: [
        {
          fileId: 'f000001',
          entryId: updated.value.entries.find((entry) => entry.name === 'large.sav').entryId,
        },
      ],
    })
    try {
      const bytes = await collect(await largeArchive.openArchive())
      await writeFile(join(OUTPUT, 'windows-large.gz'), bytes)
      const assets = join(REPO_ROOT, 'apps/mobile/android/app/build/generated/archive-interop')
      await writeFile(join(assets, 'windows-large.bin'), bytes)
      await writeFile(join(assets, 'windows-large.json'), JSON.stringify(largeArchive.manifest))
    } finally {
      await largeArchive.dispose()
    }
    console.log('Windows 原生归档已生成，供 JVM 和设备消费。')
  } else if (mode === 'verify-device-saf') {
    const report = join(REPO_ROOT, '.reports/wp013-device')
    const manifest = JSON.parse(await readFile(join(report, 'saf-manifest.json'), 'utf8'))
    const bytes = await readFile(join(report, 'saf.gz'))
    const received = await archive.receive(manifest, Readable.from([bytes]))
    try {
      assert.equal(manifest.files.length, 4)
      assert.equal(manifest.totalFileBytes, 131096)
      for (const file of manifest.files) {
        assert.ok(['empty.sav', 'large.sav', '存档😀.sav'].includes(file.sourceName))
        if (file.sourceParentId !== null) assert.equal(file.sourceName, 'empty.sav')
        const local =
          file.sourceParentId !== null
            ? 'control.sav'
            : file.sourceName === 'large.sav'
              ? 'large.sav'
              : file.sourceName === 'empty.sav'
                ? 'empty.sav'
                : 'unicode.sav'
        assert.deepEqual(
          await collect(await received.openFile(file.fileId)),
          await readFile(join(report, local)),
        )
      }
    } finally {
      await received.dispose()
    }
    console.log('实际 SAF → Java 归档 → Windows 原生解包与四份上传原文完全一致。')
  } else {
    const bytes = await readFile(
      mode === 'verify-device'
        ? join(REPO_ROOT, '.reports/wp013-device/java.gz')
        : join(OUTPUT, 'java.gz'),
    )
    const manifest = {
      ...FIXTURE.manifest,
      archive: {
        ...FIXTURE.manifest.archive,
        sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    }
    const received = await archive.receive(manifest, Readable.from([bytes]))
    try {
      for (const [index, file] of manifest.files.entries())
        assert.deepEqual(
          await collect(await received.openFile(file.fileId)),
          Buffer.from(FIXTURE.contentsBase64[index], 'base64'),
        )
    } finally {
      await received.dispose()
    }
    assert.deepEqual(await readdir(join(privateDirectory, 'transfer-archives-v1')), [
      'cache-root.json',
    ])
    console.log(
      `${mode === 'verify-device' ? '设备 Java' : 'JVM Java'} → Windows 原生解包及独立内容期望验证通过。`,
    )
  }
} finally {
  await archive.retryCleanup()
  // 只删除此脚本在固定报告目录内生成的源夹具；报告用于后续 Android 互通验证。
  if (mode === 'verify') {
    const root = join(OUTPUT, 'source')
    for (const [index] of FIXTURE.contentsBase64.entries())
      await unlink(join(root, `夹具 ${index}.sav`))
    await unlink(join(root, 'large.sav'))
    await rmdir(root)
  }
}
