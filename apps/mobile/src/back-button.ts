import { App as CapacitorApp } from '@capacitor/app'
import type { PluginListenerHandle } from '@capacitor/core'
import type { BackButtonController } from '@savedata-sync/ui'

/** 把 Android 返回键交给界面处理；界面未消费时退出应用。 */
export const androidBackButton: BackButtonController = {
  subscribe(handler) {
    let isActive = true
    let listener: PluginListenerHandle | null = null
    void CapacitorApp.addListener('backButton', () => {
      if (!handler()) {
        void CapacitorApp.exitApp().catch(() => undefined)
      }
    })
      .then((value) => {
        if (isActive) {
          listener = value
        } else {
          void value.remove().catch(() => undefined)
        }
      })
      .catch(() => undefined)
    return () => {
      isActive = false
      if (listener) {
        void listener.remove().catch(() => undefined)
        listener = null
      }
    }
  },
}
