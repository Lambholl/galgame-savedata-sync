import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { installDesignTokens } from '@savedata-sync/shared/ui'
import { DesktopRoot } from './app/DesktopRoot.tsx'
import { installDesktopBridges } from './platform/desktop-bridges.ts'
import './styles/desktop.css'

installDesktopBridges()
installDesignTokens()

const container = document.getElementById('root')
if (!container) {
  throw new Error('Application root element is missing')
}

createRoot(container).render(
  <StrictMode>
    <DesktopRoot />
  </StrictMode>,
)
