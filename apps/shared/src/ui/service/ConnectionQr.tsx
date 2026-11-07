import { QRCodeSVG } from 'qrcode.react'
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
 * 颜色跟主题走：SVG 底色透明、模块用 currentColor，由外层 .ss-connection-qr 的底色和文字色决定；
 * SVG 的 fill 属性不认 CSS 变量，所以不直接把变量传给组件。
 */
export function ConnectionQr({ text, size, label }: ConnectionQrProps): React.JSX.Element {
  return (
    <div className="ss-connection-qr">
      <QRCodeSVG
        value={text}
        size={size}
        level="M"
        bgColor="transparent"
        fgColor="currentColor"
        title={label}
      />
    </div>
  )
}
