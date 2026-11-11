import { useState, type ReactElement } from 'react'
import type { SyncBackupFile } from '../../sync/sync-contracts.ts'
import { fileKindOf } from '../../sync/snapshot-compare.ts'
import { FilePane } from '../files/FilePane.tsx'
import type { PaneRow } from '../files/FilePane.tsx'
import { useT } from '../i18n/i18n-context.ts'

/** BackupFiles 的参数。 */
export interface BackupFilesProps {
  /** 列头路径的起点，通常是备份所属目录的显示名。 */
  readonly rootName: string
  /** 所选备份里的文件；读取中为 null。 */
  readonly files: readonly SyncBackupFile[] | null
  /** 读取文件清单失败时写在列里的说明；没有失败时为 null。 */
  readonly failure: string | null
}

/** 某一层里的文件夹与文件：文件夹按名称排在前面，文件夹没有大小和时间。 */
function rowsAt(files: readonly SyncBackupFile[], path: readonly string[]): PaneRow[] {
  const folders = new Set<string>()
  const rows: PaneRow[] = []
  for (const file of files) {
    if (file.path.length <= path.length || path.some((name, index) => file.path[index] !== name)) {
      continue
    }
    const name = file.path[path.length] ?? ''
    if (file.path.length > path.length + 1) {
      folders.add(name)
      continue
    }
    rows.push({
      name,
      kind: fileKindOf(name, 'file'),
      path: file.path,
      sizeBytes: file.sizeBytes,
      modifiedAt: file.modifiedAt,
      marker: 'none',
      tone: 'same',
    })
  }
  const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name)
  return [
    ...[...folders].sort().map((name): PaneRow => ({
      name,
      kind: 'directory',
      path: [...path, name],
      sizeBytes: null,
      modifiedAt: null,
      marker: 'none',
      tone: 'same',
    })),
    ...rows.sort(byName),
  ]
}

/** 用文件列显示一份备份里的文件，可以进入文件夹浏览。 */
export function BackupFiles({ rootName, files, failure }: BackupFilesProps): ReactElement {
  const t = useT()
  const [path, setPath] = useState<readonly string[]>([])
  const rows = files && rowsAt(files, path)
  const directories = rows?.filter((row) => row.kind === 'directory').length ?? 0
  return (
    <FilePane
      label={rootName}
      crumb={[rootName, ...path].join(' / ')}
      rows={failure ? [] : rows}
      isLoading={files === null}
      foot={
        failure
          ? [failure]
          : rows && rows.length > 0
            ? [t('compare.summary', { directories, files: rows.length - directories })]
            : [t('compare.emptyFolder')]
      }
      onOpen={setPath}
      onUp={path.length > 0 ? () => setPath(path.slice(0, -1)) : null}
    />
  )
}
