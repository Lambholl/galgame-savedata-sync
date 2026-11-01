import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { installDesignTokens } from '@savedata-sync/shared/ui'
import { DesktopRoot } from './app/DesktopRoot.tsx'
import './styles/desktop.css'

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
