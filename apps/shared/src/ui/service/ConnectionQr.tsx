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

// 纠错等级用 M：载荷不到 300 个字符，二维码不会太密，屏幕反光或局部遮挡时仍能识别。
// SVG 的 fill 属性不认 CSS 变量，所以底色透明、模块用 currentColor，颜色由外层 .ss-connection-qr 决定。
/** 显示连接二维码，颜色跟随主题。 */
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
