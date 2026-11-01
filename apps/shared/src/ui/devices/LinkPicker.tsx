import type { ReactElement } from 'react'
import { CheckOutlined, DesktopOutlined, MobileOutlined } from '@ant-design/icons'
import { useT } from '../i18n/i18n-context.ts'
import './devices.css'

/** 关联时可选的一台设备。 */
export interface LinkPickerDevice {
  /** 设备 ID，传回 onSelectDevice。 */
  readonly deviceId: string
  /** 设备名。 */
  readonly name: string
  /** 设备类型，决定图标。 */
  readonly kind: 'pc' | 'phone'
  /** available 可选；linked 已关联，不可再选；offline 未连接，读不到游戏列表。 */
  readonly state: 'available' | 'linked' | 'offline'
}

/** 所选设备上的一个游戏。 */
export interface LinkPickerGame {
  /** 对方的游戏 ID，传回 onSelectGame。 */
  readonly id: string
  /** 对方的游戏名。 */
  readonly name: string
  /** 与本机游戏同名，标为推荐。 */
  readonly isRecommended: boolean
}

/** LinkPicker 的参数。弹层标题、说明和确认按钮由平台渲染。 */
export interface LinkPickerProps {
  /** 第一步列出的设备；isDeviceStepShown 为 false 时不显示。 */
  readonly devices: readonly LinkPickerDevice[]
  /** 是否显示第一步；改为对应其他游戏时设备已确定，只显示第二步。 */
  readonly isDeviceStepShown: boolean
  /** 已选设备；未选时为 null，此时不显示第二步。 */
  readonly selectedDevice: { readonly deviceId: string; readonly name: string } | null
  /** 已选设备上的游戏。 */
  readonly games: readonly LinkPickerGame[]
  /** 已选游戏；未选时为 null。 */
  readonly selectedGameId: string | null
  /** 选中一台可用设备。 */
  readonly onSelectDevice: (deviceId: string) => void
  /** 选中一个游戏。 */
  readonly onSelectGame: (gameId: string) => void
  /** 未连接的设备上点“去连接”，通常打开设备页。 */
  readonly onConnect: () => void
}

/** 关联设备的两步选择：先选设备，再选它上面对应的游戏；同名游戏标为推荐。 */
export function LinkPicker({
  devices,
  isDeviceStepShown,
  selectedDevice,
  games,
  selectedGameId,
  onSelectDevice,
  onSelectGame,
  onConnect,
}: LinkPickerProps): ReactElement {
  const t = useT()
  return (
    <div className="ss-picker">
      {isDeviceStepShown && (
        <section>
          <h3 className="ss-step-title">
            <b>1</b>
            {t('game.linkStepDevice')}
          </h3>
          {devices.length ? (
            <div className="ss-list">
              {devices.map((item) => {
                const icon = item.kind === 'pc' ? <DesktopOutlined /> : <MobileOutlined />
                const lead = (
                  <span className={`ss-list-lead${item.state === 'available' ? ' is-accent' : ''}`}>
                    {icon}
                    {item.state !== 'linked' && (
                      <i className={`ss-list-dot${item.state === 'available' ? ' is-on' : ''}`} />
                    )}
                  </span>
                )
                if (item.state === 'available') {
                  const isSelected = selectedDevice?.deviceId === item.deviceId
                  return (
                    <button
                      type="button"
                      className="ss-list-row"
                      key={item.deviceId}
                      aria-pressed={isSelected}
                      onClick={() => onSelectDevice(item.deviceId)}
                    >
                      {lead}
                      <span className="ss-list-body">
                        <b>{item.name}</b>
                        <small>{t('transfer.connected')}</small>
                      </span>
                      <span className={`ss-radio${isSelected ? ' is-on' : ''}`} />
                    </button>
                  )
                }
                return (
                  <div className="ss-list-row is-disabled" key={item.deviceId}>
                    {lead}
                    <span className="ss-list-body">
                      <b>{item.name}</b>
                      <small>
                        {item.state === 'linked' ? t('game.linked') : t('game.needsConnection')}
                      </small>
                    </span>
                    {item.state === 'linked' ? (
                      <CheckOutlined className="ss-list-check" />
                    ) : (
                      <button type="button" className="ss-list-link" onClick={onConnect}>
                        {t('game.goConnect')}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="ss-list-empty">{t('game.noDevices')}</p>
          )}
        </section>
      )}
      {selectedDevice && (
        <section>
          <h3 className="ss-step-title">
            {isDeviceStepShown && <b>2</b>}
            {t('game.linkStepGame', { name: selectedDevice.name })}
          </h3>
          {games.length ? (
            <div className="ss-list">
              {games.map((item) => {
                const isSelected = selectedGameId === item.id
                return (
                  <button
                    type="button"
                    className="ss-list-row"
                    key={item.id}
                    aria-pressed={isSelected}
                    onClick={() => onSelectGame(item.id)}
                  >
                    <span className="ss-list-body">
                      <b>{item.name}</b>
                      {item.isRecommended && <small className="is-ok">{t('game.sameName')}</small>}
                    </span>
                    <span className={`ss-radio${isSelected ? ' is-on' : ''}`} />
                  </button>
                )
              })}
            </div>
          ) : (
            <p className="ss-list-empty">{t('game.noRemoteGames')}</p>
          )}
        </section>
      )}
    </div>
  )
}
