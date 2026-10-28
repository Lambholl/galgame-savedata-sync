import { useEffect, useState } from 'react'
import { Alert, Button, Modal, Space, Switch } from 'antd'
import { unwrap } from '@savedata-sync/shared'
import { desktopBackups } from '../../platform/sync-adapter.ts'

/** 缺少项目设置时默认开启；关闭前说明覆盖后旧内容的去向，保存后才切换状态。 */
export function BackupPreference({
  projectId,
  rootId,
  rootLabel,
  isDisabled,
}: {
  readonly projectId: string
  readonly rootId: string
  readonly rootLabel: string
  readonly isDisabled: boolean
}): React.JSX.Element {
  const [shouldBackup, setShouldBackup] = useState(true),
    [isLoading, setIsLoading] = useState(true),
    [isSaving, setIsSaving] = useState(false),
    [isConfirmOpen, setIsConfirmOpen] = useState(false),
    [error, setError] = useState(''),
    [version, setVersion] = useState(0)
  useEffect(() => {
    let isCurrent = true
    setIsLoading(true)
    setError('')
    setIsConfirmOpen(false)
    async function read(): Promise<void> {
      const info = unwrap(await desktopBackups().read())
      if (isCurrent) {
        setShouldBackup(
          info.settings.projects.find(
            (item) => item.projectId === projectId && item.rootId === rootId,
          )?.shouldBackup ?? true,
        )
      }
    }
    void read()
      .catch((cause: unknown) => {
        if (isCurrent) {
          setError(cause instanceof Error ? cause.message : '读取备份设置失败。')
        }
      })
      .finally(() => {
        if (isCurrent) {
          setIsLoading(false)
        }
      })
    return () => {
      isCurrent = false
    }
  }, [projectId, rootId, version])
  function save(shouldEnable: boolean): void {
    if (isSaving || isDisabled || isLoading) {
      return
    }
    setIsSaving(true)
    setError('')
    async function write(): Promise<void> {
      unwrap(await desktopBackups().setPreference(projectId, rootId, shouldEnable))
      setShouldBackup(shouldEnable)
      setIsConfirmOpen(false)
    }
    void write()
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : '保存备份设置失败。'),
      )
      .finally(() => setIsSaving(false))
  }
  return (
    <div className="library-stack">
      <Space wrap>
        <Switch
          aria-label="覆盖前自动备份"
          checked={shouldBackup}
          loading={isLoading || isSaving}
          disabled={isDisabled || isLoading || isSaving || Boolean(error)}
          onChange={(shouldEnable) => {
            if (shouldEnable) {
              save(true)
            } else {
              setIsConfirmOpen(true)
            }
          }}
        />
        <span>覆盖前自动备份</span>
      </Space>
      <p>
        {isLoading
          ? '正在读取本机备份设置。'
          : shouldBackup
            ? '接收文件时，先备份被覆盖的旧内容，最近保留 3 次。'
            : '备份已关闭。接收文件时会直接覆盖旧内容。'}{' '}
        本机恢复始终先保护当前内容。
      </p>
      {error && (
        <Alert
          showIcon
          type="error"
          title={error}
          action={
            <Button size="small" onClick={() => setVersion((value) => value + 1)}>
              重新读取
            </Button>
          }
        />
      )}
      <Modal
        open={isConfirmOpen}
        title="关闭这个目录的自动备份"
        okText="关闭备份"
        cancelText="继续保留备份"
        okButtonProps={{ danger: true, disabled: isDisabled }}
        cancelButtonProps={{ disabled: isSaving }}
        confirmLoading={isSaving}
        mask={{ closable: !isSaving }}
        closable={!isSaving}
        keyboard={!isSaving}
        onCancel={() => {
          if (!isSaving) {
            setIsConfirmOpen(false)
          }
        }}
        onOk={() => save(false)}
      >
        <p className="library-directory-path">{rootLabel}</p>
        <p>后续接收文件时会直接覆盖旧内容，旧内容无法从本次备份恢复。已有备份继续保留。</p>
      </Modal>
    </div>
  )
}
