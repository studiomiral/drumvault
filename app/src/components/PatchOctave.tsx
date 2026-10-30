import { useApp } from '../store/app'

/** The octave a patch remembers (set with −12 / +12 in Generate), when it has one. */
export function PatchOctave({ role, path }: { role: 'bass' | 'keys'; path: string }) {
  const octave = useApp((s) => s.settings?.[role]?.octaves?.[path] ?? 0)
  if (!octave) return null
  return (
    <span className="text-accent text-[11.5px] ml-1 whitespace-nowrap" title="Every next track with this patch plays it in this octave">
      patch {octave > 0 ? '+' : '−'}{Math.abs(octave)} st
    </span>
  )
}
