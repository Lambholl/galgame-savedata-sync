/** 切到当前页的方式，决定切页方向：forward 打开新页，back 回到来源，lateral 主导航之间切换。 */
export type NavigationDirection = 'forward' | 'back' | 'lateral'

/** 来源记录的一层：离开时的页面，以及重新显示它需要的上下文。 */
export interface PageSource<P, C> {
  readonly page: P
  readonly context: C
}

/** 当前页、来源记录和切到当前页的方式；下面的函数都返回新状态，不修改传入的状态。 */
export interface PageNavigationState<P, C> {
  readonly page: P
  readonly sources: readonly PageSource<P, C>[]
  readonly direction: NavigationDirection
}

/** 冷启动的状态：显示 page，没有来源记录。 */
export function createNavigationState<P, C>(page: P): PageNavigationState<P, C> {
  return { page, sources: [], direction: 'lateral' }
}

/** 返回时要回到的来源；没有来源记录时为 null。 */
export function backSource<P, C>(state: PageNavigationState<P, C>): PageSource<P, C> | null {
  return state.sources.at(-1) ?? null
}

/**
 * 从当前页打开 target，并用 sourceContext 记下当前页。
 * target 已在来源记录里时退回它，它之后的记录作废，不新开一层；target 就是当前页时状态不变。
 */
export function openPage<P, C>(
  state: PageNavigationState<P, C>,
  target: P,
  sourceContext: C,
): PageNavigationState<P, C> {
  if (state.page === target) {
    return state
  }
  const index = state.sources.findIndex((source) => source.page === target)
  return index >= 0
    ? { page: target, sources: state.sources.slice(0, index), direction: 'back' }
    : {
        page: target,
        sources: [...state.sources, { page: state.page, context: sourceContext }],
        direction: 'forward',
      }
}

/** 回到最近的来源页；没有来源记录时状态不变。 */
export function goBack<P, C>(state: PageNavigationState<P, C>): PageNavigationState<P, C> {
  const source = backSource(state)
  return source
    ? { page: source.page, sources: state.sources.slice(0, -1), direction: 'back' }
    : state
}

/** 切到主导航页 target 并清空来源记录。 */
export function openMainPage<P, C>(target: P): PageNavigationState<P, C> {
  return { page: target, sources: [], direction: 'lateral' }
}

/** 结束当前流程并打开 target：之前的来源记录作废，返回时只回 homePage，并带上 homeContext。 */
export function finishPageFlow<P, C>(
  target: P,
  homePage: P,
  homeContext: C,
): PageNavigationState<P, C> {
  return {
    page: target,
    sources: [{ page: homePage, context: homeContext }],
    direction: 'forward',
  }
}
