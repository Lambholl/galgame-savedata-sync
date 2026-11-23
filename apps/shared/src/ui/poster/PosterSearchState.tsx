import type { ReactElement } from 'react'
import { Button, Empty, Spin } from 'antd'
import type { PosterSearchErrorCode, PosterSource } from '../../poster/poster-contracts.ts'
import type { Translate } from '../../i18n/translate.ts'
import { useT } from '../i18n/i18n-context.ts'
import { POSTER_SOURCE_NAMES } from './poster-labels.ts'
import './poster.css'

/**
 * 封面搜索结果区没有候选可显示时的状态。
 * loading：正在搜索；empty：来源没有找到关键词；no-covers：NextMoe 作品下没有封面；failed：搜索失败。
 */
export type PosterSearchStatus =
  | { readonly kind: 'loading' }
  | { readonly kind: 'empty'; readonly source: PosterSource; readonly keyword: string }
  | { readonly kind: 'no-covers' }
  | {
      readonly kind: 'failed'
      readonly source: PosterSource
      readonly code: PosterSearchErrorCode
    }

/** PosterSearchState 的参数。 */
export interface PosterSearchStateProps {
  /** 要显示的状态。 */
  readonly status: PosterSearchStatus
  /** 点“重试”时调用；只有 failed 且 code 不是 bad-response 时显示重试按钮。 */
  readonly onRetry: () => void
}

/** 封面搜索结果区的加载、无结果和失败提示，在结果区内居中。 */
export function PosterSearchState({ status, onRetry }: PosterSearchStateProps): ReactElement {
  const t = useT()
  if (status.kind === 'loading') {
    return (
      <div className="ss-poster-state">
        <Spin />
      </div>
    )
  }
  let description: string
  if (status.kind === 'empty') {
    description = t('poster.empty', {
      source: POSTER_SOURCE_NAMES[status.source],
      keyword: status.keyword,
    })
  } else if (status.kind === 'no-covers') {
    description = t('poster.noCovers')
  } else {
    description = failureText(status.source, status.code, t)
  }
  // 响应格式不符是来源接口变了，重试也不会好。
  const canRetry = status.kind === 'failed' && status.code !== 'bad-response'
  return (
    <div className="ss-poster-state">
      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={description}>
        {canRetry ? <Button onClick={onRetry}>{t('common.retry')}</Button> : null}
      </Empty>
    </div>
  )
}

function failureText(source: PosterSource, code: PosterSearchErrorCode, t: Translate): string {
  const params = { source: POSTER_SOURCE_NAMES[source] }
  switch (code) {
    case 'network':
      return t('poster.network', params)
    case 'rate-limited':
      return t('poster.rateLimited', params)
    case 'service-error':
      return t('poster.serviceError', params)
    case 'bad-response':
      return t('poster.badResponse', params)
  }
}
