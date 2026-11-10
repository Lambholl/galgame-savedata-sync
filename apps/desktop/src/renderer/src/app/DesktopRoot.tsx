import { useEffect } from 'react'
import { createTranslator } from '@savedata-sync/shared'
import { I18nProvider, LocalDeviceProvider } from '@savedata-sync/shared/ui'
import { DesktopApp } from './DesktopApp.tsx'
import { useAppPreferences } from './use-app-preferences.ts'

/** 读取界面偏好，提供语言和本机设备种类，页面与弹窗都在其下渲染。 */
export function DesktopRoot(): React.JSX.Element {
  const appPreferences = useAppPreferences()
  useEffect(() => {
    document.documentElement.lang = appPreferences.locale
    document.title = createTranslator(appPreferences.locale)('app.name')
  }, [appPreferences.locale])
  return (
    <I18nProvider locale={appPreferences.locale}>
      <LocalDeviceProvider device="pc">
        <DesktopApp appPreferences={appPreferences} />
      </LocalDeviceProvider>
    </I18nProvider>
  )
}
