import type { InputHTMLAttributes } from 'react'

/**
 * A native slider that goes back to its default (`reset`) on ⌥-click or double-click, like every
 * slider in the app (BarSlider too).
 */
export function Range({ value, reset, onValue, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange'> & {
  value: number
  reset: number
  onValue: (v: number) => void
}) {
  return (
    <input type="range" value={value} {...rest} onChange={(e) => onValue(Number(e.target.value))}
           onMouseDown={(e) => {
             if (!e.altKey) return
             e.preventDefault()  // the thumb stays where the click didn't send it
             onValue(reset)
           }}
           onDoubleClick={() => onValue(reset)} />
  )
}
