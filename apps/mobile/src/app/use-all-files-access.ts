import { useEffect, useState } from 'react'
import { allFilesAccess } from '../platform/all-files-access'

/** {@link useAllFilesAccess} 的结果。 */
export interface AllFilesAccessStatus {
  /** 是否有所有文件访问权限；查询中、读不到或不在 Android 上为 null。 */
  readonly isGranted: boolean | null
  /** 正在打开系统授权页，用户还没返回应用。 */
  readonly isOpening: boolean
  /** 打开系统授权页，用户返回应用后更新 isGranted；打不开时 reject。 */
  readonly openSettings: () => Promise<void>
}

/** 查询所有文件访问权限，挂载时和每次回到应用时各查一次。 */
export function useAllFilesAccess(): AllFilesAccessStatus {
  const [isGranted, setIsGranted] = useState<boolean | null>(null)
  const [isOpening, setIsOpening] = useState(false)
  useEffect(() => {
    let isCurrent = true
    function refresh(): void {
      allFilesAccess
        .status()
        .then((state) => {
          if (isCurrent) {
            setIsGranted(state?.isGranted ?? null)
          }
        })
        .catch((cause: unknown) => {
          console.error('Failed to read all-files access state', cause)
        })
    }
    // 用户也可能从系统设置直接改权限，回到应用时重新查询。
    function handleVisibilityChange(): void {
      if (document.visibilityState === 'visible') {
        refresh()
      }
    }
    refresh()
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      isCurrent = false
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [])
  async function openSettings(): Promise<void> {
    setIsOpening(true)
    try {
      const state = await allFilesAccess.openSettings()
      setIsGranted(state?.isGranted ?? null)
    } finally {
      setIsOpening(false)
    }
  }
  return { isGranted, isOpening, openSettings }
}
