import { useState } from 'react'
import {
  backSource,
  createNavigationState,
  finishPageFlow,
  goBack,
  openMainPage,
  openPage,
} from './page-navigation.ts'
import type { NavigationDirection, PageNavigationState } from './page-navigation.ts'

export type { NavigationDirection } from './page-navigation.ts'

/** {@link usePageNavigation} 的输入。 */
export interface PageNavigationOptions<P, C> {
  /** 冷启动显示的页面。 */
  readonly initialPage: P
  /** 结束一次流程后，返回按钮回到的页面。 */
  readonly homePage: P
  /** 当前页的上下文；离开时记入来源记录。 */
  readonly context: C
  /** 返回来源页时恢复它离开时的上下文。 */
  readonly onRestore: (context: C) => void
}

/** 当前页和切页操作。 */
export interface PageNavigation<P, C> {
  readonly page: P
  /** 返回时回到的页面；没有来源记录时为 null。 */
  readonly backTarget: P | null
  readonly direction: NavigationDirection
  /**
   * 从当前页打开目标页，并把当前页记为来源。目标已在来源记录里时退回到它。
   * 传入 sourceContext 时，用它代替 context 记录当前页。
   */
  readonly open: (target: P, sourceContext?: C) => void
  /** 回到最近的来源页；没有来源记录时状态不变。 */
  readonly back: () => void
  /** 切到主导航页并清空来源记录。 */
  readonly openMain: (target: P) => void
  /** 结束当前流程并打开目标页：清空来源记录，返回时回到 homePage。 */
  readonly finishFlow: (target: P) => void
}

/** 管理页面导航状态：记录来源，返回时恢复来源页的上下文。 */
export function usePageNavigation<P, C>({
  initialPage,
  homePage,
  context,
  onRestore,
}: PageNavigationOptions<P, C>): PageNavigation<P, C> {
  const [state, setState] = useState<PageNavigationState<P, C>>(() =>
    createNavigationState(initialPage),
  )
  return {
    page: state.page,
    backTarget: backSource(state)?.page ?? null,
    direction: state.direction,
    open: (target, sourceContext = context) => {
      setState((current) => openPage(current, target, sourceContext))
    },
    back: () => {
      const source = backSource(state)
      if (!source) {
        return
      }
      onRestore(source.context)
      setState(goBack(state))
    },
    openMain: (target) => {
      setState(openMainPage(target))
    },
    finishFlow: (target) => {
      setState(finishPageFlow(target, homePage, context))
    },
  }
}
