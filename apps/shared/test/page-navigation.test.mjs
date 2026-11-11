import assert from 'node:assert/strict'
import test from 'node:test'
import {
  backSource,
  createNavigationState,
  finishPageFlow,
  goBack,
  openMainPage,
  openPage,
} from '../src/ui/navigation/page-navigation.ts'

// 页面用占位名，用例只覆盖来源记录的规则，增删页面或改某页的返回目标时用例保持通过。

/** 从 first 依次打开 rest，每层的上下文是离开的页面名加 -context。 */
function openedThrough(first, ...rest) {
  return rest.reduce(
    (state, target) => openPage(state, target, `${state.page}-context`),
    createNavigationState(first),
  )
}

test('冷启动显示初始页，没有返回目标', () => {
  const state = createNavigationState('a')
  assert.equal(state.page, 'a')
  assert.equal(backSource(state), null)
})

test('打开新页后，返回回到来源页并带回离开时的上下文', () => {
  const opened = openedThrough('a', 'b')
  assert.equal(opened.page, 'b')
  assert.equal(opened.direction, 'forward')
  assert.deepEqual(backSource(opened), { page: 'a', context: 'a-context' })

  const returned = goBack(opened)
  assert.equal(returned.page, 'a')
  assert.equal(returned.direction, 'back')
  assert.equal(backSource(returned), null)
})

test('多层页面按打开顺序逐层返回', () => {
  const opened = openedThrough('a', 'b', 'c')
  assert.equal(goBack(opened).page, 'b')
  assert.equal(goBack(goBack(opened)).page, 'a')
})

test('没有来源记录时返回不改变状态', () => {
  const state = createNavigationState('a')
  assert.equal(goBack(state), state)
})

test('打开当前页不改变状态', () => {
  const state = openedThrough('a', 'b')
  assert.equal(openPage(state, 'b', 'ignored'), state)
})

test('目标已在来源记录里时退回它，不新开一层', () => {
  const state = openPage(openedThrough('a', 'b', 'c', 'd'), 'b', 'ignored')
  assert.equal(state.page, 'b')
  assert.equal(state.direction, 'back')
  assert.deepEqual(backSource(state), { page: 'a', context: 'a-context' })
  assert.equal(backSource(goBack(state)), null)
})

test('切到主导航页清空来源记录', () => {
  const state = openMainPage('a')
  assert.equal(state.page, 'a')
  assert.equal(state.direction, 'lateral')
  assert.equal(backSource(state), null)
})

test('结束流程后之前的来源作废，只能返回主页', () => {
  const state = finishPageFlow('done', 'home', 'home-context')
  assert.equal(state.page, 'done')
  assert.deepEqual(backSource(state), { page: 'home', context: 'home-context' })

  const returned = goBack(state)
  assert.equal(returned.page, 'home')
  assert.equal(backSource(returned), null)
})
