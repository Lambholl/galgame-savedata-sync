import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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

/** 本机服务在局域网里的广播状态。 */
export type ServiceDiscoveryStatus = 'off' | 'starting' | 'advertising' | 'failed'

/** ServiceHero 的参数。 */
export interface ServiceHeroProps {
  /** 服务状态，决定状态胶囊、开关外观以及显示地址还是端口设置。 */
  readonly state: ServiceHeroState
  /** 推荐地址，写成 `IPv4:端口`；服务停止或读不到本机地址时为 null。 */
  readonly address: string | null
  /** 服务已启动、本机地址还在读取：地址位置和二维码位置显示加载动画。 */
  readonly isAddressLoading: boolean
  /** 开始监听的时间（Unix 毫秒），运行时据此显示运行时长；服务停止时为 null。 */
  readonly startedAt: number | null
  /** 局域网广播状态，运行时显示在运行信息里；off 时不显示这一项。 */
  readonly discovery: ServiceDiscoveryStatus
  /** 连接二维码的内容；为 null 时不显示二维码和二维码按钮。 */
  readonly qrText: string | null
  /** 刚复制过地址，复制按钮显示对勾。 */
  readonly isCopied: boolean
  /** 正在执行其他操作，开关暂不可按。 */
  readonly isToggleDisabled: boolean
  /** 服务停止时显示在地址位置的端口设置。 */
  readonly portEditor: ReactNode
  /** 紧凑排版：开关缩小，卡片圆角和内边距收小，二维码不论卡片多宽都收进地址旁的按钮。 */
  readonly isCompact: boolean
  /** 按下主开关：服务停止时启动，运行时停止。 */
  readonly onToggle: () => void
  /** 复制推荐地址。 */
  readonly onCopy: () => void
  /** 点按二维码按钮；卡片太窄放不下二维码或 isCompact 时，这个按钮显示在地址旁。 */
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
 * 本机服务卡片：标题和状态胶囊、推荐地址、运行时长和局域网广播状态，右侧是二维码和主开关。
 * 服务停止时地址换成端口设置。地址旁放不下二维码时二维码收进地址旁的按钮，卡片更窄时地址单独占一行；
 * isCompact 时开关和卡片边距另用小一号的尺寸。
 */
export function ServiceHero({
  state,
  address,
  isAddressLoading,
  startedAt,
  discovery,
  qrText,
  isCopied,
  isToggleDisabled,
  portEditor,
  isCompact,
  onToggle,
  onCopy,
  onShowQr,
}: ServiceHeroProps): React.JSX.Element {
  const t = useT()
  const isRunning = state === 'running'
  const isTransitioning = state === 'starting' || state === 'stopping'
  const uptime = useUptime(isRunning ? startedAt : null)
  const discoveryLabel = DISCOVERY_LABELS[discovery]
  const hasInlineQr = isRunning && !isCompact
  const [isQrFolded, setIsQrFolded] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const addressRef = useRef<HTMLDivElement>(null)
  const qrRef = useRef<HTMLDivElement>(null)
  const toggleRef = useRef<HTMLDivElement>(null)
  // 地址按原本的字号放不下时收起二维码，不缩小地址。地址的宽度随字体变化，CSS 算不出来，只能量。
  // 按“二维码在场时信息栏有多宽”判断：收起的二维码只隐藏、不占位置，仍量得到宽度，
  // 地址的字号只随卡片宽度变化，所以收起和展开两种状态下算出的结论相同，不会来回切换。
  // 比的是看得见的边：开关的光晕伸进二维码右侧的间距 --ss-service-glow，地址行也可以伸进左侧间距同样多，
  // 两边留出的空隙看起来一样宽；按钮只算图标，不算图标四周的空白。
  useLayoutEffect(() => {
    const body = bodyRef.current
    const addressRow = addressRef.current
    const qr = qrRef.current
    const toggle = toggleRef.current
    if (!hasInlineQr || !body || !addressRow || !qr || !toggle) {
      return
    }
    const measure = (): void => {
      // 地址行不换行也不收缩，各部分按原本的宽度排开。二维码按钮只在收起时出现，不算进去。
      const visibleRight = Math.max(
        ...Array.from(addressRow.children)
          .filter(
            (child) =>
              child.getClientRects().length > 0 &&
              !child.classList.contains('ss-service-qr-button'),
          )
          .map((child) => {
            const icon = child.tagName === 'BUTTON' ? child.querySelector('.anticon') : null
            return (icon ?? child).getBoundingClientRect().right
          }),
      )
      const needed = visibleRight - addressRow.getBoundingClientRect().left
      const bodyStyle = getComputedStyle(body)
      const infoWidth =
        body.clientWidth -
        (parseFloat(bodyStyle.paddingLeft) || 0) -
        (parseFloat(bodyStyle.paddingRight) || 0) -
        toggle.getBoundingClientRect().width -
        qr.getBoundingClientRect().width -
        2 * (parseFloat(bodyStyle.columnGap) || 0)
      const glow = parseFloat(getComputedStyle(toggle).getPropertyValue('--ss-service-glow')) || 0
      setIsQrFolded(Math.ceil(needed) > infoWidth + glow)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(body)
    for (const child of Array.from(addressRow.children)) {
      observer.observe(child)
    }
    return () => observer.disconnect()
  }, [hasInlineQr, address, isAddressLoading])
  const heroClasses = [
    'ss-service-hero',
    `is-${state}`,
    isCompact ? 'is-compact' : null,
    hasInlineQr && isQrFolded ? 'is-qr-folded' : null,
  ]
  return (
    <section className={heroClasses.filter((name) => name !== null).join(' ')}>
      <div className="ss-service-body" ref={bodyRef}>
        <div className="ss-service-info">
          <div className="ss-service-head">
            <div className="ss-service-title">
              <WifiOutlined />
              {t('service.title')}
            </div>
            <span className={`ss-service-pill is-${state}`}>{t(STATE_LABELS[state])}</span>
          </div>
          {isRunning ? (
            <div className="ss-service-address" ref={addressRef}>
              {isAddressLoading ? (
                <span className="ss-service-no-address" role="status">
                  <LoadingOutlined /> {t('service.addressLoading')}
                </span>
              ) : address === null ? (
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
          {isRunning ? (
            <dl className="ss-service-meta">
              <div>
                <dt>{t('service.uptime')}</dt>
                <dd>{uptime}</dd>
              </div>
              {discoveryLabel ? (
                <div>
                  <dt>{t('service.discovery')}</dt>
                  <dd className={discovery === 'failed' ? 'is-warn' : undefined}>
                    {t(discoveryLabel)}
                  </dd>
                </div>
              ) : null}
            </dl>
          ) : null}
        </div>
        {hasInlineQr && isAddressLoading ? (
          <div className="ss-service-qr" ref={qrRef}>
            {/* 和二维码同样大小，读到地址后二维码出现在原处，卡片不跳动。 */}
            <div className="ss-connection-qr-placeholder" aria-hidden="true">
              <LoadingOutlined />
            </div>
          </div>
        ) : null}
        {hasInlineQr && !isAddressLoading && qrText !== null ? (
          <div className="ss-service-qr" ref={qrRef}>
            <ConnectionQr text={qrText} size={132} label={t('service.qrTitle')} />
          </div>
        ) : null}
        <div className="ss-service-toggle-slot" ref={toggleRef}>
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
