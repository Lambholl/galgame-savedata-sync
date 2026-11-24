import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  BACKUP_MANIFEST_SCHEMA_VERSION,
  BACKUP_SETTINGS_SCHEMA_VERSION,
  DATA_RESET_ITEMS,
  LIBRARY_SCHEMA_VERSION,
  isLibraryConfig,
} from '@savedata-sync/shared'
import {
  BACKUP_LOCATION_FILE,
  BACKUP_LOCATION_SCHEMA_VERSION,
  readBackupLocation,
  saveBackupLocation,
} from '../src/backend/backup-location.ts'
import { createWindowsBackupStore } from '../src/backend/backup-store.ts'
import { NewerDataError, setAsideUnreadableData } from '../src/backend/data-recovery.ts'
import { DEVICE_IDENTITY_SCHEMA_VERSION, loadDeviceId } from '../src/backend/device-identity.ts'
import { createDirectoryAdapter } from '../src/backend/directory-adapter.ts'
import {
  DIRECTORY_REGISTRY_SCHEMA_VERSION,
  loadDirectoryRegistry,
  saveDirectoryRegistry,
} from '../src/backend/directory-store.ts'
import { WindowsSyncScanner } from '../src/backend/sync-scanner.ts'

// 样本按格式版本冻结在 fixtures/compat：<所属端>/<数据项>/v<版本>.json，备份是 shared/backup/v<清单版本>/ 下的备份库。
const COMPAT = fileURLToPath(new URL('./fixtures/compat/', import.meta.url))

async function createBase(t) {
  const base = await mkdtemp(join(await realpath(tmpdir()), 'savedata-compat-test-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  return base
}

/** 一个数据项的全部样本，按版本从旧到新。 */
async function samplesOf(directory) {
  const names = await readdir(join(COMPAT, directory))
  return names
    .map((name) => ({ name, version: Number(/^v(\d+)\.json$/.exec(name)?.[1]) }))
    .filter((item) => Number.isSafeInteger(item.version))
    .sort((a, b) => a.version - b.version)
    .map((item) => ({ version: item.version, path: join(COMPAT, directory, item.name) }))
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

/** 在 settingsPath 所在目录打开备份存储；备份设置文件名必须是 backup-settings.json。 */
async function withBackupStore(settingsPath, work) {
  const directory = join(settingsPath, '..')
  const adapter = await createDirectoryAdapter(join(directory, 'directories.json'))
  const store = await createWindowsBackupStore(
    adapter,
    join(directory, 'backups'),
    directory,
    () => null,
  )
  try {
    return await work(store)
  } finally {
    await store.stop()
  }
}

/**
 * 带版本的数据项。read 用读取这项数据的模块读出内容，读不了时抛错；
 * write 用写入模块把读出的内容写回，没有单独写入接口的数据项为 null。
 */
const ITEMS = [
  {
    item: 'device-identity',
    directory: 'desktop/device-identity',
    version: DEVICE_IDENTITY_SCHEMA_VERSION,
    read: async (path) => ({ deviceId: await loadDeviceId(path) }),
    write: null,
  },
  {
    item: 'directories',
    directory: 'desktop/directories',
    version: DIRECTORY_REGISTRY_SCHEMA_VERSION,
    read: async (path) => {
      const registry = await loadDirectoryRegistry(path)
      assert.ok(registry)
      return registry
    },
    write: (path, registry) => saveDirectoryRegistry(path, registry),
  },
  {
    item: 'library',
    directory: 'shared/library',
    version: LIBRARY_SCHEMA_VERSION,
    read: async (path) => {
      const value = await readJson(path)
      assert.ok(isLibraryConfig(value))
      return value
    },
    write: null,
  },
  {
    item: 'backup-settings',
    directory: 'shared/backup-settings',
    version: BACKUP_SETTINGS_SCHEMA_VERSION,
    read: (path) => withBackupStore(path, (store) => store.settings()),
    write: (path, settings) =>
      withBackupStore(path, (store) => store.setKeepCount(settings.keepCount)),
  },
  {
    item: 'backup-library',
    directory: 'desktop/backup-library',
    version: BACKUP_LOCATION_SCHEMA_VERSION,
    read: async (path) => {
      const location = await readBackupLocation(path)
      assert.ok(location)
      return location
    },
    write: (path, location) => saveBackupLocation(path, location),
  },
]

/** 数据项放进临时数据目录时用的文件名；备份设置和备份位置要用读取模块认的名字。 */
function fileNameOf(item) {
  return item === 'backup-settings'
    ? 'backup-settings.json'
    : item === 'backup-library'
      ? BACKUP_LOCATION_FILE
      : `${item}.json`
}

function dataPaths(base) {
  return Object.fromEntries(DATA_RESET_ITEMS.map((name) => [name, join(base, fileNameOf(name))]))
}

async function currentSample({ directory, version }) {
  return (await samplesOf(directory)).find((sample) => sample.version === version)
}

test('每个带版本的数据项和备份清单在当前格式版本都有样本', async () => {
  for (const entry of ITEMS) {
    assert.ok(await currentSample(entry), `${entry.item} 缺少 v${entry.version} 的样本`)
  }
  const backups = await readdir(join(COMPAT, 'shared/backup'))
  assert.ok(backups.includes(`v${BACKUP_MANIFEST_SCHEMA_VERSION}`))
})

test('全部样本启动检查不重置，读取模块能读出', async (t) => {
  for (const { item, directory, read } of ITEMS) {
    for (const sample of await samplesOf(directory)) {
      const paths = dataPaths(await createBase(t))
      await cp(sample.path, paths[item])
      assert.deepEqual(await setAsideUnreadableData(paths), [], `${item} v${sample.version}`)
      await read(paths[item])
    }
  }
})

test('当前版本的样本读出再写回后内容不变', async (t) => {
  for (const entry of ITEMS) {
    if (!entry.write) {
      continue
    }
    const sample = await currentSample(entry)
    const path = join(await createBase(t), fileNameOf(entry.item))
    await cp(sample.path, path)
    const value = await entry.read(path)
    await rm(path)
    await entry.write(path, value)
    assert.deepEqual(await readJson(path), await readJson(sample.path), entry.item)
  }
})

test('数据写成更高版本时拒绝启动，所有数据文件原样保留', async (t) => {
  const base = await createBase(t)
  const paths = dataPaths(base)
  const written = new Map()
  for (const entry of ITEMS) {
    const sample = await currentSample(entry)
    const text = JSON.stringify({
      ...(await readJson(sample.path)),
      schemaVersion: entry.version + 1,
    })
    await writeFile(paths[entry.item], text)
    written.set(paths[entry.item], text)
  }
  // 端口设置读不懂，其他数据较新时它也不能被改名。
  await writeFile(paths['service-settings'], 'not json')
  written.set(paths['service-settings'], 'not json')

  await assert.rejects(setAsideUnreadableData(paths), (error) => {
    assert.ok(error instanceof NewerDataError)
    assert.deepEqual([...error.items].sort(), ITEMS.map((entry) => entry.item).sort())
    return true
  })
  for (const [path, text] of written) {
    assert.equal(await readFile(path, 'utf8'), text)
  }
  assert.equal((await readdir(base)).length, written.size)
})

/** 把某个清单版本的备份样本放进新的备份库，返回打开的备份存储和样本清单。 */
async function openBackupSample(t, version) {
  const base = await createBase(t)
  const backups = join(base, 'backups')
  await cp(join(COMPAT, 'shared/backup', `v${version}`), backups, { recursive: true })
  const [game] = await readdir(backups)
  const [round] = await readdir(join(backups, game))
  const roundPath = join(backups, game, round)
  const manifest = await readJson(join(roundPath, 'backup.json'))
  const saves = join(base, 'saves')
  await mkdir(saves)
  // 只列出本机写的备份：样本备份和身份样本来自同一台设备，升级后设备 ID 不变。
  const identity = await currentSample(ITEMS.find((entry) => entry.item === 'device-identity'))
  await cp(identity.path, join(base, 'identity.json'))
  const adapter = await createDirectoryAdapter(join(base, 'directories.json'))
  const store = await createWindowsBackupStore(adapter, backups, base, () => null)
  t.after(() => store.stop())
  return { adapter, saves, store, manifest, roundPath }
}

async function sha256(stream) {
  const hash = createHash('sha256')
  for await (const chunk of stream) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}

test('全部备份样本能列出，读出的文件与备份里的文件相同', async (t) => {
  for (const name of await readdir(join(COMPAT, 'shared/backup'))) {
    const { store, manifest, roundPath } = await openBackupSample(t, Number(name.slice(1)))
    const listing = await store.list(manifest.projectId)
    assert.deepEqual(
      listing.backups.map((backup) => backup.backupId),
      [manifest.backupId],
    )
    assert.deepEqual(listing.incomplete, [])
    const handle = await store.acquire(manifest.projectId, manifest.backupId)
    try {
      for (const file of manifest.files) {
        const { stream, verifyUnchanged } = await handle.openFile(file.fileId)
        const actual = await sha256(stream)
        await verifyUnchanged()
        const expected = createHash('sha256')
          .update(await readFile(join(roundPath, 'files', ...file.path)))
          .digest('hex')
        assert.equal(actual, expected, file.path.join('/'))
      }
    } finally {
      await handle.release()
    }
  }
})

test('清单版本更高的备份不列出、不算残留，轮换时不删除', async (t) => {
  const { adapter, saves, store, manifest, roundPath } = await openBackupSample(
    t,
    BACKUP_MANIFEST_SCHEMA_VERSION,
  )
  const newer = { ...manifest, schemaVersion: BACKUP_MANIFEST_SCHEMA_VERSION + 1 }
  await writeFile(join(roundPath, 'backup.json'), JSON.stringify(newer))
  await writeFile(join(saves, 'slot.sav'), 'current save')
  const root = await adapter.registerDirectory(saves)
  assert.equal(root.status, 'success')
  const scanner = new WindowsSyncScanner(adapter)
  t.after(() => scanner.stop())
  const scan = await scanner.wait(scanner.start(root.value.rootId).scanId)
  await store.setKeepCount(1)

  const commit = await store.createManual(manifest.projectId, scan.snapshot)
  assert.ok(commit.manifest)
  const listing = await store.list(manifest.projectId)
  assert.deepEqual(
    listing.backups.map((backup) => backup.backupId),
    [commit.manifest.backupId],
  )
  assert.deepEqual(listing.incomplete, [])
  assert.deepEqual(await readJson(join(roundPath, 'backup.json')), newer)
})
