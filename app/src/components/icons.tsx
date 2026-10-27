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
