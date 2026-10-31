import { useEffect } from 'react'
import { I18nProvider } from '@savedata-sync/shared/ui'
import { DesktopApp } from './DesktopApp.tsx'
import { useAppPreferences } from './use-app-preferences.ts'

/** 读取界面偏好并提供语言，页面与弹窗都在其下渲染。 */
export function DesktopRoot(): React.JSX.Element {
  const appPreferences = useAppPreferences()
  useEffect(() => {
    document.documentElement.lang = appPreferences.locale
  }, [appPreferences.locale])
  return (
    <I18nProvider locale={appPreferences.locale}>
      <DesktopApp appPreferences={appPreferences} />
    </I18nProvider>
  )
}
