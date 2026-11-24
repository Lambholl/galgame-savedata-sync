import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  BACKUP_MANIFEST_SCHEMA_VERSION,
  BACKUP_SETTINGS_SCHEMA_VERSION,
  LIBRARY_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  SYNC_CAPABILITIES_VERSION,
  SYNC_JOB_SCHEMA_VERSION,
} from '../src/index.ts'

const JAVA = new URL(
  '../../mobile/android/app/src/main/java/io/github/galgame/savedatasync/',
  import.meta.url,
)

// 两端读写同一格式或在网络上互认的版本：Android 的 Java 常量和共享包的常量必须相同。
const PAIRS = [
  ['TransferSchema', 'PROTOCOL_VERSION', PROTOCOL_VERSION],
  ['SyncJobModel', 'CAPABILITIES_VERSION', SYNC_CAPABILITIES_VERSION],
  ['SyncJobModel', 'JOB_SCHEMA_VERSION', SYNC_JOB_SCHEMA_VERSION],
  ['ListenerLibrary', 'LIBRARY_VERSION', LIBRARY_SCHEMA_VERSION],
  ['BackupModel', 'SETTINGS_VERSION', BACKUP_SETTINGS_SCHEMA_VERSION],
  ['BackupModel', 'MANIFEST_VERSION', BACKUP_MANIFEST_SCHEMA_VERSION],
]

test('Android 与共享包的协议、能力和共用格式版本相同', async () => {
  for (const [className, name, expected] of PAIRS) {
    const source = await readFile(new URL(`${className}.java`, JAVA), 'utf8')
    const match = new RegExp(`static final int ${name} = (\\d+);`).exec(source)
    assert.ok(match, `${className}.${name} 不存在`)
    assert.equal(Number(match[1]), expected, `${className}.${name}`)
  }
})
