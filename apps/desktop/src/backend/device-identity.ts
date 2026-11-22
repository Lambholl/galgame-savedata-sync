import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { isOpaqueId } from '@savedata-sync/shared'
import { DirectoryAccessError } from './directory-errors.ts'

/** 设备身份文件（schema 1）：这次安装的稳定设备 ID。 */
export interface DeviceIdentity {
  readonly schemaVersion: 1
  readonly deviceId: string
}

/** 校验设备身份文件的内容。 */
export function isDeviceIdentity(value: unknown): value is DeviceIdentity {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 2 &&
    'schemaVersion' in value &&
    value.schemaVersion === 1 &&
    'deviceId' in value &&
    isOpaqueId(value.deviceId)
  )
}

async function saveIdentity(path: string, identity: DeviceIdentity): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = join(dirname(path), `.identity-${randomUUID()}.tmp`)
  const handle = await open(temporaryPath, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(identity)}\n`, 'utf8')
    await handle.sync()
  } catch (error) {
    await handle.close()
    await unlink(temporaryPath)
    throw error
  }
  await handle.close()
  try {
    await rename(temporaryPath, path)
  } catch (error) {
    await unlink(temporaryPath)
    throw error
  }
}

/**
 * 读取设备 ID；身份文件不存在时生成新的设备 ID 并保存。
 *
 * @param path 身份文件的绝对路径。
 * @throws DirectoryAccessError 路径不是绝对路径，文件是链接、不是普通文件或超过 64 KiB，或者内容损坏、版本未知时抛出，原文件保留。
 */
export async function loadDeviceId(path: string): Promise<string> {
  if (!isAbsolute(path)) {
    throw new DirectoryAccessError('invalid-request', 'The identity path must be absolute.')
  }
  let stats
  try {
    stats = await lstat(path)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      const identity: DeviceIdentity = { schemaVersion: 1, deviceId: randomUUID() }
      await saveIdentity(path, identity)
      return identity.deviceId
    }
    throw error
  }
  if (!stats.isFile() || stats.size > 64 * 1024) {
    throw new DirectoryAccessError(
      'invalid-request',
      'The device identity file type or size is invalid.',
    )
  }
  let value: unknown
  try {
    value = JSON.parse(await readFile(path, 'utf8'))
  } catch (cause) {
    throw new DirectoryAccessError('invalid-request', 'The device identity file is damaged.', cause)
  }
  if (!isDeviceIdentity(value)) {
    throw new DirectoryAccessError(
      'invalid-request',
      'The device identity format or version is invalid.',
    )
  }
  return value.deviceId
}
