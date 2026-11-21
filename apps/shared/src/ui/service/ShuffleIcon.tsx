import { useId } from 'react'

/** 左上到右下的线，画在上层。 */
const OVER_PATH = 'M3 7h3c3 0 4.5 10 8.5 10H20'
/** 左下到右上的线，在交叉处断开，看起来从另一条线下面穿过。 */
const UNDER_PATH = 'M3 17h3c3 0 4.5-10 8.5-10H20'

/** 两条交叉的箭头，表示随机。大小跟随字号（1em），颜色跟随文字颜色。 */
export function ShuffleIcon(): React.JSX.Element {
  // useId 的值带冒号，冒号在 CSS 里有特殊含义；放进 url(#…) 前去掉，不依赖浏览器对未转义冒号的容错。
  const maskId = `shuffle-gap-${useId().replace(/:/g, '')}`
  // 线宽按 24 格画布取 1.8，字号 18px 时约 1.35px，和 @ant-design/icons 的线框图标粗细接近。
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <defs>
        {/* 沿上层的线挖一道比线宽两侧各宽约 1.6 格的缝，下层的线在缝里不画。 */}
        <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
          <rect width="24" height="24" fill="white" stroke="none" />
          <path d={OVER_PATH} stroke="black" strokeWidth={5} strokeLinecap="butt" />
        </mask>
      </defs>
      <path d={UNDER_PATH} mask={`url(#${maskId})`} />
      <path d={OVER_PATH} />
      <path d="m17 4 3 3-3 3" />
      <path d="m17 14 3 3-3 3" />
    </svg>
  )
}
