/** 所有按钮和可点的行；禁用的不给按下反馈。 */
const PRESSABLE = [
  'button:not(:disabled)',
  'a.adm-list-item:not(.adm-list-item-disabled)',
  '.adm-action-sheet-button-item:not(.adm-action-sheet-button-item-disabled)',
  '.ant-dropdown-menu-item:not(.ant-dropdown-menu-item-disabled)',
].join(', ')
/** 按下动画的时长，与 mobile.css 里的按下过渡一致。 */
const PRESS_IN_MS = 200

/**
 * 给按钮和可点的行加按下反馈：按下时加 is-pressed，渐变出一层遮罩；松开后再褪去。
 * 轻点时也等按下动画走完再褪去，否则 :active 一闪而过几乎看不到。
 * 滑动列表时浏览器会取消指针，遮罩随之褪去。返回停止函数。
 */
export function startPressFeedback(): () => void {
  let pressed: { readonly row: Element; readonly at: number } | null = null
  function press(event: PointerEvent): void {
    const row = event.target instanceof Element ? event.target.closest(PRESSABLE) : null
    if (!row || !event.isPrimary) {
      return
    }
    pressed = { row, at: performance.now() }
    row.classList.add('is-pressed')
  }
  function release(): void {
    if (!pressed) {
      return
    }
    const { row, at } = pressed
    pressed = null
    const wait = Math.max(0, PRESS_IN_MS - (performance.now() - at))
    window.setTimeout(() => {
      if (pressed?.row !== row) {
        row.classList.remove('is-pressed')
      }
    }, wait)
  }
  document.addEventListener('pointerdown', press, { passive: true })
  document.addEventListener('pointerup', release, { passive: true })
  document.addEventListener('pointercancel', release, { passive: true })
  return () => {
    document.removeEventListener('pointerdown', press)
    document.removeEventListener('pointerup', release)
    document.removeEventListener('pointercancel', release)
  }
}
