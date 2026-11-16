// The pre-flight's scorecard (SCOPE.md §6.5a): the checks of an export's masters, what is wrong
// first, over the track's loudness bar by bar with its drops marked.

import type { MixProfile, PreflightCheck, PreflightResult } from '../types/engine'

// (No shared UI imports: the scorecard is rendered in the tests, which run without the app's components.)
const cx = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ')
const DOT: Record<PreflightCheck['status'], string> = { ok: 'bg-ok', warn: 'bg-warn', info: 'bg-faint' }
/** The curve's range under its loudest bar (LU). */
const CURVE_LU = 18

/** The loudness of every bar, the drops lit: the track's shape as it came out. */
export function LoudnessCurve({ profile }: { profile: MixProfile }) {
  const bars = profile.bar_lufs
  const top = Math.max(...bars.map((v) => v ?? -Infinity))
  if (!bars.length || !Number.isFinite(top)) return null
  const inDrop = (b: number) => profile.drops.some((d) => b >= d.bar && b < d.bar + d.bars)
  return (
    <svg viewBox={`0 0 ${bars.length} 100`} preserveAspectRatio="none" className="w-full h-9 rounded bg-panel-2" role="img"
         aria-label="Loudness bar by bar, the drops lit">
      {bars.map((v, b) => {
        const h = v === null ? 0 : Math.max(0, Math.min(1, 1 - (top - v) / CURVE_LU)) * 100
        return <rect key={b} x={b + 0.1} y={100 - h} width={0.8} height={h} className={inDrop(b) ? 'fill-accent' : 'fill-faint'} />
      })}
    </svg>
  )
}

export function Preflight({ result }: { result: PreflightResult }) {
  const profile = result.master ?? result.mix
  const { tracks, pending } = result.references
  return (
    <div className="mb-3 rounded-lg border border-line bg-panel-2 p-3">
      <div className="flex items-baseline justify-between mb-2">
        <span className="font-medium">Pre-flight of the {result.subject}</span>
        <span className={cx('text-[12px]', result.warnings ? 'text-warn' : 'text-ok')}>
          {result.warnings ? `${result.warnings} to look at` : 'nothing to look at'}
        </span>
      </div>
      <LoudnessCurve profile={profile} />
      <ul className="mt-2 space-y-1">
        {result.checks.map((c) => (
          <li key={c.id} className="grid grid-cols-[10px_170px_1fr] items-baseline gap-x-2 text-[12.5px]" title={c.detail || undefined}>
            <span className={cx('w-2 h-2 rounded-full self-center', DOT[c.status])} />
            <span className={c.status === 'warn' ? 'text-text' : 'text-muted'}>{c.label}</span>
            <span className={cx('select-text', c.status === 'warn' ? 'text-warn' : c.status === 'ok' ? 'text-text' : 'text-muted')}>{c.value}</span>
            {c.status !== 'ok' && c.detail && (
              <span className="col-start-2 col-span-2 text-[11.5px] text-faint leading-snug select-text">{c.detail}</span>
            )}
          </li>
        ))}
      </ul>
      {(tracks > 0 || pending > 0) && (
        <p className="mt-2 text-[11.5px] text-faint">
          {tracks} reference track{tracks === 1 ? '' : 's'}
          {pending > 0 && <>, {pending} more in the folder not measured yet (Settings → References)</>}.
        </p>
      )}
    </div>
  )
}
