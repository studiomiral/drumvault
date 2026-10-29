import type { View } from '../store/app'

export type MenuIconName = View | 'shortcuts'

// Render directly from the full-resolution artwork. Pre-shrinking the transparent
// renders introduced edge ringing before Chromium's final display-size reduction.
// Explicit URLs also bundle the source images into packaged Electron builds.
const artwork: Record<MenuIconName, string> = {
  process: new URL('../../artwork/menu-3d/process.png', import.meta.url).href,
  library: new URL('../../artwork/menu-3d/library.png', import.meta.url).href,
  grid: new URL('../../artwork/menu-3d/grid-waveform.png', import.meta.url).href,
  midi: new URL('../../artwork/menu-3d/midi.png', import.meta.url).href,
  generate: new URL('../../artwork/menu-3d/generate.png', import.meta.url).href,
  arrange: new URL('../../artwork/menu-3d/arrange.png', import.meta.url).href,
  settings: new URL('../../artwork/menu-3d/settings.png', import.meta.url).href,
  shortcuts: new URL('../../artwork/menu-3d/shortcuts.png', import.meta.url).href,
}

export function MenuIcon({ name }: { name: MenuIconName }) {
  return <img src={artwork[name]} alt="" aria-hidden="true" draggable={false} width={40} height={40}
              className="menu-icon" />
}
