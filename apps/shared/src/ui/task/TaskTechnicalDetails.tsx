import type { ReactElement } from 'react'
import { Button } from 'antd'
import { CodeOutlined, CopyOutlined } from '@ant-design/icons'
import { useT } from '../i18n/i18n-context.ts'
import { Expand, ExpandChevron } from '../expand/Expand.tsx'
import './sync-task-summary.css'
import './task-technical-details.css'

/** TaskTechnicalDetails 的参数。 */
export interface TaskTechnicalDetailsProps {
  /** 完整技术信息，展示与复制使用同一份文字。 */
  readonly text: string
  /** 是否展开。 */
  readonly isExpanded: boolean
  /** touch 时点按内容收起；pointer 时可以选择文字，并显示复制按钮。 */
  readonly interaction: 'touch' | 'pointer'
  /** 标题或内容请求展开、收起。 */
  readonly onExpandedChange: (isExpanded: boolean) => void
  /** 点按复制按钮。 */
  readonly onCopy: () => void
}

/** 可展开的技术详情行，外观与“已写入 N 个文件”行相同。 */
export function TaskTechnicalDetails({
  text,
  isExpanded,
  interaction,
  onExpandedChange,
  onCopy,
}: TaskTechnicalDetailsProps): ReactElement {
  const t = useT()
  return (
    <div className="ss-task-group">
      <button
        type="button"
        className="ss-task-row ss-pressable"
        aria-expanded={isExpanded}
        onClick={() => onExpandedChange(!isExpanded)}
      >
        <span className="ss-task-lead is-accent">
          <CodeOutlined />
        </span>
        <span className="ss-task-body">{t('task.tech')}</span>
        <ExpandChevron isOpen={isExpanded} />
      </button>
      <Expand isOpen={isExpanded}>
        <div className={`ss-tech-content is-${interaction}`}>
          {interaction === 'pointer' && (
            <Button
              className="ss-tech-copy"
              size="small"
              type="text"
              icon={<CopyOutlined />}
              title={t('common.copyAll')}
              aria-label={t('common.copyAll')}
              onClick={onCopy}
            />
          )}
          <pre className={interaction === 'pointer' ? 'ss-copyable' : undefined}>{text}</pre>
        </div>
      </Expand>
    </div>
  )
}
