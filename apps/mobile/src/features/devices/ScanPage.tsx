import { useEffect, useRef, useState } from 'react'
import { Button, SpinLoading } from 'antd-mobile'
import { parseConnectionQrText } from '@savedata-sync/shared'
import type { ConnectionQrPayload } from '@savedata-sync/shared'
import { useT } from '@savedata-sync/shared/ui'
import { EmptyState } from '../../components/EmptyState'
import { Sheet } from '../../components/Sheet'
import { qrScanner } from '../../platform/qr-scanner'

type ScanStatus = 'starting' | 'live' | 'denied' | 'failed'

/** 这个 class 在 html 上时，mobile.css 让出页面背景，露出 WebView 下面的取景画面。 */
const CAMERA_LIVE_CLASS = 'camera-live'

/**
 * 扫码页：页面打开期间相机一直开着，离开页面即关闭。扫到有效的连接二维码时调用 onScanned，由调用方离开本页并连接。
 * 协议版本不同时提示更新两台设备，其他二维码调用 onInvalidCode，都继续扫描。
 * 没有相机权限或相机打不开时显示说明，并提供手动输入地址的入口。
 */
export function ScanPage({
  onScanned,
  onInvalidCode,
  onManualInput,
  onOverlayChange,
}: {
  readonly onScanned: (payload: ConnectionQrPayload) => void
  /** 扫到的不是本应用的连接二维码；相机对着它时每 2 秒调用一次。 */
  readonly onInvalidCode: () => void
  readonly onManualInput: () => void
  /** 提示打开时登记关闭函数，Android 返回键先关提示，再按才离开本页。 */
  readonly onOverlayChange: (close: (() => void) | null) => void
}): React.JSX.Element {
  const t = useT()
  const [status, setStatus] = useState<ScanStatus>('starting')
  const [attempt, setAttempt] = useState(0)
  const [isOutdated, setIsOutdated] = useState(false)
  const hasScanned = useRef(false)

  function handleDetected(text: string): void {
    if (hasScanned.current || isOutdated) {
      return
    }
    const result = parseConnectionQrText(text)
    if (result.status === 'valid') {
      hasScanned.current = true
      onScanned(result.payload)
    } else if (result.status === 'unsupported-version') {
      setIsOutdated(true)
    } else {
      onInvalidCode()
    }
  }
  const latestHandler = useRef(handleDetected)
  useEffect(() => {
    latestHandler.current = handleDetected
  })

  useEffect(() => qrScanner.watchDetected((text) => latestHandler.current(text)), [])

  useEffect(() => {
    let isCurrent = true
    setStatus('starting')
    qrScanner
      .start()
      .then((result) => {
        if (isCurrent) {
          setStatus(result === 'started' ? 'live' : result)
        }
      })
      .catch((cause: unknown) => {
        console.error('Failed to show the camera', cause)
      })
    return () => {
      isCurrent = false
      qrScanner.stop()
    }
  }, [attempt])

  useEffect(() => {
    if (status !== 'live') {
      return undefined
    }
    document.documentElement.classList.add(CAMERA_LIVE_CLASS)
    return () => document.documentElement.classList.remove(CAMERA_LIVE_CLASS)
  }, [status])

  useEffect(() => {
    if (status !== 'denied') {
      return undefined
    }
    return qrScanner.watchPermissionGranted(() => setAttempt((value) => value + 1))
  }, [status])

  useEffect(() => {
    if (!isOutdated) {
      return undefined
    }
    onOverlayChange(() => setIsOutdated(false))
    return () => onOverlayChange(null)
  }, [isOutdated, onOverlayChange])

  if (status === 'denied' || status === 'failed') {
    return (
      <EmptyState description={t(status === 'denied' ? 'device.scanDenied' : 'device.scanFailed')}>
        <div className="scan-fallback">
          {status === 'denied' ? (
            <Button color="primary" onClick={() => qrScanner.openAppSettings()}>
              {t('device.scanOpenSettings')}
            </Button>
          ) : (
            <Button color="primary" onClick={() => setAttempt((value) => value + 1)}>
              {t('common.retry')}
            </Button>
          )}
          <Button onClick={onManualInput}>{t('device.scanManual')}</Button>
        </div>
      </EmptyState>
    )
  }
  return (
    <div className="scan-view">
      {status === 'starting' ? (
        <SpinLoading />
      ) : (
        <>
          <span className="scan-frame">
            <span className="scan-line" />
          </span>
          <span className="scan-hint">{t('device.scanHint')}</span>
        </>
      )}
      <Sheet
        isOpen={isOutdated}
        title={t('device.scanOutdatedTitle')}
        layer={1200}
        isBusy={false}
        onClose={() => setIsOutdated(false)}
      >
        <p className="confirmation-text">{t('device.scanOutdatedText')}</p>
        <div className="action-row equal">
          <Button color="primary" onClick={() => setIsOutdated(false)}>
            {t('common.gotIt')}
          </Button>
        </div>
      </Sheet>
    </div>
  )
}
