import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/hanken-grotesk'
import '@fontsource-variable/newsreader'
import { App } from './App'
import './index.css'

// The macOS window is frosted (vibrancy); elsewhere the body paints a solid base.
document.documentElement.classList.toggle('vibrant', window.drumvault.platform === 'darwin')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
