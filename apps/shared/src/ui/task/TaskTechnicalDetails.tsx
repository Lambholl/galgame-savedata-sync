import type { ReactElement } from 'react'
import { Button, Card, Collapse } from 'antd'
import { CodeOutlined, CopyOutlined, RightOutlined } from '@ant-design/icons'
import { useT } from '../i18n/i18n-context.ts'
import './task-technical-details.css'

/** 技术详情卡片的展示和平台回调。 */
export interface TaskTechnicalDetailsProps {
  /** 完整技术信息，展示与复制使用同一份文字。 */
  readonly text: string
  /** 卡片是否展开；展开状态由平台组件保存。 */
  readonly isExpanded: boolean
  /** 触控模式点击内容收起，指针模式保留文字选择和复制按钮。 */
  readonly interaction: 'touch' | 'pointer'
  /** 标题或内容请求展开、收起。 */
  readonly onExpandedChange: (isExpanded: boolean) => void
  /** 复制全部内容；剪贴板及反馈由平台处理。 */
  readonly onCopy: () => void
}

/** 圆角卡片内使用折叠面板，触控长按由手机端包装组件处理。 */
export function TaskTechnicalDetails({
  text,
  isExpanded,
  interaction,
  onExpandedChange,
  onCopy,
}: TaskTechnicalDetailsProps): ReactElement {
  const t = useT()
  return (
    <Card
      className="ss-tech-card"
      classNames={{ body: 'ss-tech-card-shell' }}
      size="small"
      variant="borderless"
    >
      <Collapse
        ghost
        activeKey={isExpanded ? ['technical'] : []}
        onChange={(keys) => onExpandedChange(keys.includes('technical'))}
        expandIconPlacement="end"
        expandIcon={({ isActive }) => <RightOutlined rotate={isActive ? 90 : 0} />}
        classNames={{ header: 'ss-tech-header', body: 'ss-tech-body' }}
        items={[
          {
            key: 'technical',
            label: (
              <span className="ss-tech-title">
                <span className="ss-tech-symbol">
                  <CodeOutlined />
                </span>
                {t('task.tech')}
              </span>
            ),
            children: (
              <div className={`ss-tech-content is-${interaction}`}>
                {interaction === 'pointer' ? (
                  <>
                    <Button
                      className="ss-tech-copy"
                      size="small"
                      type="text"
                      icon={<CopyOutlined />}
                      title={t('common.copyAll')}
                      aria-label={t('common.copyAll')}
                      onClick={onCopy}
                    />
                    <pre className="ss-copyable">{text}</pre>
                  </>
                ) : (
                  <Button
                    className="ss-tech-touch-content"
                    type="text"
                    block
                    onClick={() => onExpandedChange(false)}
                  >
                    <pre>{text}</pre>
                  </Button>
                )}
              </div>
            ),
          },
        ]}
      />
    </Card>
  )
}
