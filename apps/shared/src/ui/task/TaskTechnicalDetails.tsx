import type { ReactElement } from 'react'
import { Button } from 'antd'
import { CodeOutlined, CopyOutlined } from '@ant-design/icons'
import { useT } from '../i18n/i18n-context.ts'
import { Expand, ExpandChevron } from '../expand/Expand.tsx'
import './sync-task-summary.css'
import './task-technical-details.css'

/** 技术详情的展示和平台回调。 */
export interface TaskTechnicalDetailsProps {
  /** 完整技术信息，展示与复制使用同一份文字。 */
  readonly text: string
  /** 是否展开；展开状态由平台组件保存。 */
  readonly isExpanded: boolean
  /** 触控模式点击内容收起，指针模式保留文字选择和复制按钮。 */
  readonly interaction: 'touch' | 'pointer'
  /** 标题或内容请求展开、收起。 */
  readonly onExpandedChange: (isExpanded: boolean) => void
  /** 复制全部内容；剪贴板及反馈由平台处理。 */
  readonly onCopy: () => void
}

/** 与“已写入 N 个文件”同一种可展开行；触控长按由手机端包装组件处理。 */
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
