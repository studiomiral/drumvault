// Small inline icons (stroke = currentColor).

type P = { className?: string }
const base = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

export const IconProcess = ({ className }: P) => (
  <svg viewBox="0 0 20 20" className={className} {...base}><path d="M10 3v9m0 0-3.5-3.5M10 12l3.5-3.5M3.5 13.5v2A1.5 1.5 0 0 0 5 17h10a1.5 1.5 0 0 0 1.5-1.5v-2" /></svg>
)
export const IconLibrary = ({ className }: P) => (
  <svg viewBox="0 0 20 20" className={className} {...base}><path d="M4 3.5v13M8 3.5v13M12 4l3.5 12.2" /></svg>
)
export const IconArrange = ({ className }: P) => (
  <svg viewBox="0 0 20 20" className={className} {...base}><rect x="3" y="4" width="7" height="3" rx="1" /><rect x="8" y="9" width="9" height="3" rx="1" /><rect x="5" y="14" width="6" height="3" rx="1" /></svg>
)
export const IconTrash = ({ className }: P) => (
  <svg viewBox="0 0 20 20" className={className} {...base}><path d="M4 6h12M8 6V4.5h4V6M5.5 6l.8 9.6a1.5 1.5 0 0 0 1.5 1.4h4.4a1.5 1.5 0 0 0 1.5-1.4L14.5 6M8.5 9v5M11.5 9v5" /></svg>
)
export const IconMidi = ({ className }: P) => (
  <svg viewBox="0 0 20 20" className={className} {...base}><rect x="3" y="4" width="14" height="12" rx="1.5" /><path d="M7 4v7M10 4v7M13 4v7M7 11v5M10 11v5M13 11v5" strokeWidth={1.3} /></svg>
)
export const IconGrid = ({ className }: P) => (
  <svg viewBox="0 0 20 20" className={className} {...base}><path d="M3 15.5h14M4.5 4v13M10 4v13M15.5 4v13" /><path d="M6.5 11.5c.6-3 1.2-3 1.8 0M12 11.5c.6-3 1.2-3 1.8 0" strokeWidth={1.3} /></svg>
)
export const IconSettings = ({ className }: P) => (
  <svg viewBox="0 0 20 20" className={className} {...base}><circle cx="10" cy="10" r="2.5" /><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" /></svg>
)
export const IconPlay = ({ className }: P) => (
  <svg viewBox="0 0 20 20" className={className}><path d="M6 4.5v11l9-5.5z" fill="currentColor" /></svg>
)
export const IconStop = ({ className }: P) => (
  <svg viewBox="0 0 20 20" className={className}><rect x="5.5" y="5.5" width="9" height="9" rx="1" fill="currentColor" /></svg>
)
export const IconStar = ({ className, filled }: P & { filled?: boolean }) => (
  <svg viewBox="0 0 20 20" className={className} fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round">
    <path d="m10 2.8 2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L2.8 8.1l5-.7z" />
  </svg>
)
export const IconX = ({ className }: P) => (
  <svg viewBox="0 0 20 20" className={className} {...base}><path d="m5.5 5.5 9 9m0-9-9 9" /></svg>
)
export const IconFolder = ({ className }: P) => (
  <svg viewBox="0 0 20 20" className={className} {...base}><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h3l1.5 1.5h6.5A1.5 1.5 0 0 1 17 8v6.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5z" /></svg>
)
export const IconDrop = ({ className }: P) => (
  <svg viewBox="0 0 40 40" className={className} {...base} strokeWidth={1.4}><path d="M20 6v18m0 0-6-6m6 6 6-6M8 26v4a3 3 0 0 0 3 3h18a3 3 0 0 0 3-3v-4" /></svg>
)
export const IconKeyboard = ({ className }: P) => (
  <svg viewBox="0 0 20 20" className={className} {...base}><rect x="2.5" y="5" width="15" height="10" rx="2" /><path d="M5.5 8h.01M8.5 8h.01M11.5 8h.01M14.5 8h.01M6.5 12h7" /></svg>
)
/** Kind glyphs for the Process banner: a hit, a loop, a sparkle (FX), a key. */
export const IconHit = ({ className }: P) => (
  <svg viewBox="0 0 20 20" className={className} {...base}><ellipse cx="10" cy="7" rx="6.5" ry="2.5" /><path d="M3.5 7v6c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5V7" /></svg>
)
export const IconLoop = ({ className }: P) => (
  <svg viewBox="0 0 20 20" className={className} {...base}><path d="M4 9.5V8.5A3 3 0 0 1 7 5.5h8.5m0 0L13 3m2.5 2.5L13 8M16 10.5v1a3 3 0 0 1-3 3H4.5m0 0L7 17m-2.5-2.5L7 12" /></svg>
)
export const IconSparkle = ({ className }: P) => (
  <svg viewBox="0 0 20 20" className={className} {...base}><path d="M10 3c.6 3.6 1.9 5 5.5 5.5-3.6.6-4.9 1.9-5.5 5.5-.6-3.6-1.9-4.9-5.5-5.5C8.1 8 9.4 6.6 10 3zM15.5 13.5c.2 1.2.6 1.6 1.8 1.8-1.2.2-1.6.6-1.8 1.8-.2-1.2-.6-1.6-1.8-1.8 1.2-.2 1.6-.6 1.8-1.8z" /></svg>
)
export const IconKey = ({ className }: P) => (
  <svg viewBox="0 0 20 20" className={className} {...base}><path d="M7.5 3.5v9.5M12.5 3.5v9.5" /><rect x="3" y="3.5" width="14" height="13" rx="2" /><path d="M10 13v3.5" /></svg>
)
export const IconChevron = ({ className }: P) => (
  <svg viewBox="0 0 20 20" className={className} {...base}><path d="m7.5 5 5 5-5 5" /></svg>
)
export const IconCheck = ({ className }: P) => (
  <svg viewBox="0 0 20 20" className={className} {...base} strokeWidth={2.2}><path d="m5 10.5 3.2 3.2L15 6.5" /></svg>
)
export const IconLock = ({ className, open }: P & { open?: boolean }) => (
  <svg viewBox="0 0 20 20" className={className} {...base}>
    <rect x="4.5" y="9" width="11" height="8" rx="1.5" />
    <path d={open ? 'M7 9V6.5a3 3 0 0 1 5.8-1' : 'M7 9V6.5a3 3 0 0 1 6 0V9'} />
  </svg>
)
export const IconShuffle = ({ className }: P) => (
  <svg viewBox="0 0 20 20" className={className} {...base}><path d="M3 6h3.5c3.5 0 3.5 8 7 8H17m0 0-2-2m2 2-2 2M3 14h3.5c1.2 0 2-.9 2.6-2M17 6h-3.5c-1.2 0-2 .9-2.6 2M17 6l-2-2m2 2-2 2" /></svg>
)
