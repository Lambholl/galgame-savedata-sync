import { Component, createRef } from 'react'
import type { ReactNode } from 'react'
import type { NavigationDirection } from '@savedata-sync/shared/ui'
import type { Page } from '../app/navigation-types'

const SLIDE_TIMING: KeyframeAnimationOptions = {
  duration: 300,
  easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)',
}

/** 旧页面的克隆，以及插入页面后要恢复的滚动位置；index 是元素在 querySelectorAll('*') 里的序号。 */
interface OutgoingPage {
  readonly element: HTMLElement
  readonly scrolls: readonly { readonly index: number; readonly top: number }[]
}

/** {@link PageSlide} 的输入。 */
export interface PageSlideProps {
  readonly page: Page
  /** 切到当前页的方式：forward 新页从右侧进入，back 从左侧进入，lateral 按 lateralOrder 决定。 */
  readonly direction: NavigationDirection
  /** 主导航页的左右顺序。 */
  readonly lateralOrder: readonly Page[]
  /** 主导航；前后两页都有时它不动，只有一页有时它跟着那一页平移。 */
  readonly nav: ReactNode
  /** 随页面平移的内容：标题栏、正文和底部操作。 */
  readonly children: ReactNode
}

/**
 * 应用的页面容器：切页时旧页面和新页面一起平移，不做淡入。
 * 旧页面已经卸载，所以平移的是切页前克隆的 DOM，它不响应操作。
 * 只有类组件的 getSnapshotBeforeUpdate 能在 React 改 DOM 之前读到旧页面。
 */
export class PageSlide extends Component<PageSlideProps> {
  private readonly pageRef = createRef<HTMLDivElement>()
  private slide: {
    readonly element: HTMLElement
    readonly animations: readonly Animation[]
  } | null = null

  override getSnapshotBeforeUpdate(previous: PageSlideProps): OutgoingPage | null {
    const page = this.pageRef.current
    if (
      !page ||
      previous.page === this.props.page ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      return null
    }
    // 上一次平移还没结束时先收掉，页面容器的下一个兄弟节点才是主导航。
    this.stopSlide()
    const element = page.cloneNode(true) as HTMLElement
    element.classList.add('page-slide-outgoing')
    element.inert = true
    const scrolls = [...page.querySelectorAll('*')].flatMap((child, index) =>
      child.scrollTop > 0 ? [{ index, top: child.scrollTop }] : [],
    )
    const nav = page.nextElementSibling
    if (nav && !this.props.nav) {
      element.append(nav.cloneNode(true))
    }
    return { element, scrolls }
  }

  override componentDidUpdate(
    previous: PageSlideProps,
    _state: unknown,
    outgoing: OutgoingPage | null,
  ): void {
    const page = this.pageRef.current
    if (!page || !outgoing) {
      return
    }
    const { element, scrolls } = outgoing
    page.before(element)
    const children = element.querySelectorAll('*')
    for (const { index, top } of scrolls) {
      children[index]?.scrollTo({ top })
    }
    const distance = (this.isMovingBack(previous.page) ? -1 : 1) * page.offsetWidth
    // 用 translate 而不是 transform：窄屏底部导航的 transform 用来水平居中，动画不能覆盖它。
    // 距离用像素：百分比按元素自身宽度算，导航比页面窄，会走不到一起。
    const enter = [{ translate: `${distance}px 0` }, { translate: '0 0' }]
    const leave = [{ translate: '0 0' }, { translate: `${-distance}px 0` }]
    const nav = page.nextElementSibling
    const animations = [
      page.animate(enter, SLIDE_TIMING),
      element.animate(leave, SLIDE_TIMING),
      ...(nav && !previous.nav ? [nav.animate(enter, SLIDE_TIMING)] : []),
    ]
    this.slide = { element, animations }
    animations[0]?.addEventListener('finish', () => this.stopSlide())
  }

  override componentWillUnmount(): void {
    this.stopSlide()
  }

  /** 这次切页是否往回走：新页面从左侧进入。 */
  private isMovingBack(from: Page): boolean {
    const { page, direction, lateralOrder } = this.props
    return (
      direction === 'back' ||
      (direction === 'lateral' && lateralOrder.indexOf(page) < lateralOrder.indexOf(from))
    )
  }

  /** 结束正在进行的平移并移除旧页面的克隆。 */
  private stopSlide(): void {
    this.slide?.animations.forEach((animation) => animation.cancel())
    this.slide?.element.remove()
    this.slide = null
  }

  override render(): ReactNode {
    return (
      <div className="mobile-app">
        <div className="app-page" ref={this.pageRef}>
          {this.props.children}
        </div>
        {this.props.nav}
      </div>
    )
  }
}
