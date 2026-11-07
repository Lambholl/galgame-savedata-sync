import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  CheckOutlined,
  CopyOutlined,
  LoadingOutlined,
  PauseOutlined,
  PoweroffOutlined,
  QrcodeOutlined,
  WifiOutlined,
} from '@ant-design/icons'
import type { MessageKey } from '../../i18n/messages.ts'
import { useT } from '../i18n/i18n-context.ts'
import { ConnectionQr } from './ConnectionQr.tsx'
import './service-hero.css'

/** 本机服务的状态。starting 和 stopping 是按下开关后到服务真正启动或停止之间的过渡。 */
export type ServiceHeroState = 'stopped' | 'starting' | 'running' | 'stopping'

/** 本机服务在局域网里的广播状态，取值和含义同电脑端服务快照的 discovery.status。 */
export type ServiceDiscoveryStatus = 'off' | 'starting' | 'advertising' | 'failed'

/** ServiceHero 的参数。 */
export interface ServiceHeroProps {
  /** 服务状态，决定状态胶囊、开关外观以及显示地址还是端口设置。 */
  readonly state: ServiceHeroState
  /** 推荐地址，写成 `IPv4:端口`；服务停止或读不到本机地址时为 null。 */
  readonly address: string | null
  /** 开始监听的时间（Unix 毫秒），运行时据此显示运行时长；服务停止时为 null。 */
  readonly startedAt: number | null
  /** 当前连着本机的设备名；没有连接时为 null，显示“—”。 */
  readonly connectedName: string | null
  /** 局域网广播状态，运行时显示在运行信息里；off 时不显示这一项。 */
  readonly discovery: ServiceDiscoveryStatus
  /** 连接二维码的内容；为 null 时不显示二维码和二维码按钮。 */
  readonly qrText: string | null
  /** 刚复制过地址，复制按钮显示对勾。 */
  readonly isCopied: boolean
  /** 正在执行其他操作，开关暂不可按。 */
  readonly isToggleDisabled: boolean
  /** 服务停止时显示在地址位置的端口设置，由平台用自己的输入控件渲染。 */
  readonly portEditor: ReactNode
  /** 按下主开关：服务停止时启动，运行时停止。 */
  readonly onToggle: () => void
  /** 复制推荐地址。 */
  readonly onCopy: () => void
  /** 卡片太窄放不下二维码时，地址旁出现二维码按钮，点按后由平台打开放大的二维码。 */
  readonly onShowQr: () => void
}

const STATE_LABELS: Readonly<Record<ServiceHeroState, MessageKey>> = {
  stopped: 'service.stateStopped',
  starting: 'service.stateStarting',
  running: 'service.stateRunning',
  stopping: 'service.stateStopping',
}

const DISCOVERY_LABELS: Readonly<Record<ServiceDiscoveryStatus, MessageKey | null>> = {
  off: null,
  starting: 'service.discoveryStarting',
  advertising: 'service.discoveryOn',
  failed: 'service.discoveryFailed',
}

const TOGGLE_ICONS: Readonly<Record<ServiceHeroState, ReactNode>> = {
  stopped: <PoweroffOutlined />,
  starting: <LoadingOutlined />,
  running: <PauseOutlined />,
  stopping: <LoadingOutlined />,
}

/** 生成波浪圆的路径：半径随角度按 lobes 个波峰起伏，用作开关按钮的外形。 */
function wavyCircle(lobes: number, radius: number, depth: number): string {
  const points: string[] = []
  for (let step = 0; step <= 360; step += 3) {
    const angle = (step * Math.PI) / 180
    const r = radius + depth * Math.cos(lobes * angle)
    points.push(`${(r * Math.cos(angle)).toFixed(2)} ${(r * Math.sin(angle)).toFixed(2)}`)
  }
  return `M${points.join('L')}Z`
}
const WAVY_PATH = wavyCircle(9, 44, 3.2)

/** 把 startedAt 到现在的时长写成 `时:分:秒`，每秒刷新；startedAt 为 null 时返回 null。 */
function useUptime(startedAt: number | null): string | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (startedAt === null) {
      return undefined
    }
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [startedAt])
  if (startedAt === null) {
    return null
  }
  // 服务运行期间系统时间被调回时差值会小于 0，这时按 0 显示。
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`
}

/**
 * 本机服务卡片：标题和状态胶囊、推荐地址、运行时长、连着的设备和局域网广播状态，右侧是二维码和主开关。
 * 服务停止时地址换成平台传入的端口设置。排版按卡片自身宽度切换三档，见 service-hero.css。
 * 主开关是只放图标的波浪圆按钮，状态的文字说明在标题旁的胶囊里。
 */
export function ServiceHero({
  state,
  address,
  startedAt,
  connectedName,
  discovery,
  qrText,
  isCopied,
  isToggleDisabled,
  portEditor,
  onToggle,
  onCopy,
  onShowQr,
}: ServiceHeroProps): React.JSX.Element {
  const t = useT()
  const isRunning = state === 'running'
  const isTransitioning = state === 'starting' || state === 'stopping'
  const uptime = useUptime(isRunning ? startedAt : null)
  const discoveryLabel = DISCOVERY_LABELS[discovery]
  return (
    <section className={`ss-service-hero is-${state}`}>
      <div className="ss-service-body">
        <div className="ss-service-info">
          <div className="ss-service-title">
            <WifiOutlined />
            {t('service.title')}
            <span className={`ss-service-pill is-${state}`}>{t(STATE_LABELS[state])}</span>
          </div>
          {isRunning ? (
            <div className="ss-service-address">
              {address === null ? (
                <span className="ss-service-no-address">{t('service.noAddress')}</span>
              ) : (
                <>
                  <span className="ss-copyable">{address}</span>
                  <button
                    type="button"
                    className="ss-service-icon-button ss-pressable"
                    aria-label={t('device.copyAddress')}
                    onClick={onCopy}
                  >
                    {isCopied ? <CheckOutlined /> : <CopyOutlined />}
                  </button>
                </>
              )}
              {qrText !== null && (
                <button
                  type="button"
                  className="ss-service-icon-button ss-service-qr-button ss-pressable"
                  aria-label={t('service.showQr')}
                  onClick={onShowQr}
                >
                  <QrcodeOutlined />
                </button>
              )}
            </div>
          ) : (
            <div className="ss-service-port">{portEditor}</div>
          )}
          {isRunning && (
            <dl className="ss-service-meta">
              <div>
                <dt>{t('service.uptime')}</dt>
                <dd>{uptime}</dd>
              </div>
              <div>
                <dt>{t('transfer.connected')}</dt>
                <dd>{connectedName ?? '—'}</dd>
              </div>
              {discoveryLabel && (
                <div>
                  <dt>{t('service.discovery')}</dt>
                  <dd className={discovery === 'failed' ? 'is-warn' : undefined}>
                    {t(discoveryLabel)}
                  </dd>
                </div>
              )}
            </dl>
          )}
        </div>
        {isRunning && qrText !== null && (
          <div className="ss-service-qr">
            <ConnectionQr text={qrText} size={132} label={t('service.qrTitle')} />
          </div>
        )}
        <div className="ss-service-toggle-slot">
          <button
            type="button"
            className={`ss-service-toggle is-${state}`}
            aria-pressed={isRunning}
            aria-label={t(isRunning ? 'service.toggleStop' : 'service.toggleStart')}
            disabled={isTransitioning || isToggleDisabled}
            onClick={onToggle}
          >
            <svg className="ss-service-toggle-shape" viewBox="-50 -50 100 100" aria-hidden="true">
              <path className="ss-service-toggle-fill" d={WAVY_PATH} />
              <path className="ss-service-toggle-press" d={WAVY_PATH} />
            </svg>
            <span className="ss-service-toggle-icon">{TOGGLE_ICONS[state]}</span>
          </button>
        </div>
      </div>
    </section>
  )
}
