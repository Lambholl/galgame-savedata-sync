const EMPTY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

/** 仅构造纯数据清单；归档哈希占位不代表存在真实归档文件。 */
export function createManifest(sizes = [0]) {
  return {
    protocolVersion: 1,
    transferId: 'batch-1',
    sourceDeviceId: 'device-source',
    sourceRootId: 'root-source',
    files: sizes.map((sizeBytes, index) => ({
      fileId: `f${String(index + 1).padStart(6, '0')}`,
      sourceEntryId: `source-${index + 1}`,
      sourceParentId: null,
      sourceName: `源 存档 ${index + 1}.sav`,
      sourceModifiedAt: null,
      sizeBytes,
      sha256: sizeBytes === 0 ? EMPTY_HASH : 'a'.repeat(64),
    })),
    totalFileBytes: sizes.reduce((sum, size) => sum + size, 0),
    archive: {
      format: 'tar.gz',
      compressionLevel: 1,
      sizeBytes: 100,
      tarSizeBytes: sizes.reduce((sum, size) => sum + 512 + Math.ceil(size / 512) * 512, 1024),
      sha256: 'b'.repeat(64),
    },
  }
}

/** 目标为独立测试根的已有目录；不访问真实磁盘或设备。 */
export function createReceiveRequest(sizes = [0]) {
  const manifest = createManifest(sizes)
  return {
    protocolVersion: 1,
    manifest,
    targetRootId: 'root-target',
    targets: manifest.files.map((file, index) => ({
      fileId: file.fileId,
      parentId: null,
      name: `目标 😀 ${index + 1}.sav`,
    })),
  }
}

/** 构造符合清单的成功结果，供篡改字段与聚合状态的拒绝用例使用。 */
export function createReceiverState(request = createReceiveRequest()) {
  return {
    transferId: request.manifest.transferId,
    direction: 'android-to-windows',
    role: 'receiver',
    updatedAt: 0,
    status: 'succeeded',
    error: null,
    cleanupStatus: 'complete',
    cleanupError: null,
    fileResults: request.manifest.files.map((file, index) => {
      const target = request.targets.find((item) => item.fileId === file.fileId)
      return {
        fileId: file.fileId,
        status: 'succeeded',
        bytesWritten: file.sizeBytes,
        sha256: file.sha256,
        entry: {
          rootId: request.targetRootId,
          entryId: `target-${index + 1}`,
          parentId: target.parentId,
          name: target.name,
          kind: 'file',
          sizeBytes: file.sizeBytes,
          modifiedAt: null,
          capabilities: {
            canRead: 'supported',
            canList: 'unsupported',
            canCreate: 'unknown',
            canRename: 'unknown',
            canDelete: 'unknown',
          },
        },
      }
    }),
  }
}

/** 已准备 sender 状态，没有任何目标发布结果。 */
export function createSenderState(manifest = createManifest()) {
  return {
    transferId: manifest.transferId,
    direction: 'windows-to-android',
    role: 'sender',
    updatedAt: 0,
    status: 'running',
    stage: 'ready',
    cancelRequested: false,
    fileResults: null,
    progress: {
      sourceBytesRead: manifest.totalFileBytes,
      archiveBytesTransferred: 0,
      fileBytesVerified: 0,
      fileBytesPublished: 0,
      totalFileBytes: manifest.totalFileBytes,
      totalArchiveBytes: manifest.archive.sizeBytes,
      totalFiles: manifest.files.length,
      verifiedFiles: 0,
      publishedFiles: 0,
    },
  }
}

/** 归档和全部原文已校验，尚无目标发布；不构造任何 IO 通过证据。 */
export function createReceiverRunning(request = createReceiveRequest()) {
  const manifest = request.manifest
  return {
    transferId: manifest.transferId,
    direction: 'android-to-windows',
    role: 'receiver',
    updatedAt: 0,
    status: 'running',
    stage: 'publishing',
    cancelRequested: false,
    fileResults: [],
    progress: {
      sourceBytesRead: 0,
      archiveBytesTransferred: manifest.archive.sizeBytes,
      fileBytesVerified: manifest.totalFileBytes,
      fileBytesPublished: 0,
      totalFileBytes: manifest.totalFileBytes,
      totalArchiveBytes: manifest.archive.sizeBytes,
      totalFiles: manifest.files.length,
      verifiedFiles: manifest.files.length,
      publishedFiles: 0,
    },
  }
}
