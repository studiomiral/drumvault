import type { Page } from '../store/app'

export type MenuIconName = Page | 'shortcuts'

// Flat SVG artwork stays sharp at every display density. Explicit URLs let Vite
// bundle the same assets into development and packaged Electron builds.
const artwork: Record<MenuIconName, string> = {
  create: new URL('../assets/menu-flat/generate.svg', import.meta.url).href,
  drums: new URL('../assets/menu-flat/process.svg', import.meta.url).href,
  sounds: new URL('../assets/menu-flat/stabs.svg', import.meta.url).href,
  settings: new URL('../assets/menu-flat/settings.svg', import.meta.url).href,
  shortcuts: new URL('../assets/menu-flat/shortcuts.svg', import.meta.url).href,
}

export function MenuIcon({ name }: { name: MenuIconName }) {
  return <img src={artwork[name]} alt="" aria-hidden="true" draggable={false} width={24} height={24}
              className="menu-icon" />
}
