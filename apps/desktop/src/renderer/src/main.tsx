import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { DesktopApp } from './app/DesktopApp.tsx'
import './styles/desktop.css'

const container = document.getElementById('root')
if (!container) {
  throw new Error('Application root element is missing')
}

createRoot(container).render(
  <StrictMode>
    <DesktopApp />
  </StrictMode>,
)
