import { QRCodeSVG } from 'qrcode.react'
import { QR_COLORS } from '../../preferences/design-tokens.ts'
import './service-hero.css'

/** ConnectionQr 的参数。 */
export interface ConnectionQrProps {
  /** 二维码内容，由 createConnectionQrText 生成。 */
  readonly text: string
  /** 二维码图形的边长（CSS px），不含四周留白。 */
  readonly size: number
  /** 读屏软件读出的名称。 */
  readonly label: string
}

/**
 * 显示监听方的连接二维码，供另一台设备扫码连接。
 * 纠错等级用 M：载荷不到 300 个字符，二维码不会太密，屏幕反光或局部遮挡时仍能识别。
 * 外层白底留出四周空白，深色主题下也是白底黑模块。
 */
export function ConnectionQr({ text, size, label }: ConnectionQrProps): React.JSX.Element {
  return (
    <div className="ss-connection-qr">
      <QRCodeSVG
        value={text}
        size={size}
        level="M"
        bgColor={QR_COLORS.qrBg}
        fgColor={QR_COLORS.qrFg}
        title={label}
      />
    </div>
  )
}
