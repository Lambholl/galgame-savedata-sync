import type { PosterCandidate, PosterSource } from '../../poster/poster-contracts.ts'
import type { Translate } from '../../i18n/translate.ts'

/** 封面搜索来源的显示名，各语言相同。 */
export const POSTER_SOURCE_NAMES: Readonly<Record<PosterSource, string>> = {
  vndb: 'VNDB',
  nextmoe: 'NextMoe',
  bangumi: 'Bangumi',
  steam: 'Steam',
}

type CoverKindKey = `poster.kind.${'main' | 'pkgfront' | 'pkgback' | 'pkgcontent' | 'dig'}`

// 用 Map 查找：类别是外部数据，普通对象会查到 constructor 这类原型属性。
const COVER_KIND_KEYS: ReadonlyMap<string, CoverKindKey> = new Map([
  ['main', 'poster.kind.main'],
  ['pkgfront', 'poster.kind.pkgfront'],
  ['pkgback', 'poster.kind.pkgback'],
  ['pkgcontent', 'poster.kind.pkgcontent'],
  ['dig', 'poster.kind.dig'],
])

/**
 * 候选卡片第一行显示的名称。NextMoe 作品下的封面显示封面类别，其余显示标题。
 *
 * @returns 封面类别没有对应文案时原样返回；没有类别时返回标题。
 */
export function posterCandidateName(candidate: PosterCandidate, t: Translate): string {
  // NextMoe 同一部作品的封面标题都是作品名，类别才能区分它们。
  if (candidate.kind === 'work' || candidate.source !== 'nextmoe') {
    return candidate.title
  }
  if (candidate.subtitle === null) {
    return candidate.title
  }
  const key = COVER_KIND_KEYS.get(candidate.subtitle)
  return key ? t(key) : candidate.subtitle
}
