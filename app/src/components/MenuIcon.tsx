import type { View } from '../store/app'

export type MenuIconName = View | 'shortcuts'

// Flat SVG artwork stays sharp at every display density. Explicit URLs let Vite
// bundle the same assets into development and packaged Electron builds.
const artwork: Record<MenuIconName, string> = {
  process: new URL('../assets/menu-flat/process.svg', import.meta.url).href,
  library: new URL('../assets/menu-flat/library.svg', import.meta.url).href,
  grid: new URL('../assets/menu-flat/grid.svg', import.meta.url).href,
  midi: new URL('../assets/menu-flat/midi.svg', import.meta.url).href,
  hits: new URL('../assets/menu-flat/hits.svg', import.meta.url).href,
  stabs: new URL('../assets/menu-flat/stabs.svg', import.meta.url).href,
  generate: new URL('../assets/menu-flat/generate.svg', import.meta.url).href,
  arrange: new URL('../assets/menu-flat/arrange.svg', import.meta.url).href,
  settings: new URL('../assets/menu-flat/settings.svg', import.meta.url).href,
  shortcuts: new URL('../assets/menu-flat/shortcuts.svg', import.meta.url).href,
}

export function MenuIcon({ name }: { name: MenuIconName }) {
  return <img src={artwork[name]} alt="" aria-hidden="true" draggable={false} width={24} height={24}
              className="menu-icon" />
}
