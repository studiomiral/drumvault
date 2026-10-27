import { Modal } from './ui'

const SECTIONS: { title: string; rows: [string, string][] }[] = [
  {
    title: 'Everywhere',
    rows: [['⌘1 / ⌘2 / ⌘3', 'Process / Library / Arrange'], ['⌘,', 'Settings'], ['⌘O', 'Add zips'],
      ['⌘E', 'Export stems'], ['⌘/', 'This overview']],
  },
  {
    title: 'Library',
    rows: [['Click / Space', 'Play / stop the selected sample'], ['↑ / ↓', 'Previous / next sample, and play it'],
      ['Esc', 'Stop'], ['F', 'Favourite'], ['1 – 5', 'Rate (again to clear)'], ['S', 'Find similar sounds'],
      ['⌘F', 'Search'], ['Drag a row', 'Drop the WAV into Finder or Logic']],
  },
  {
    title: 'Arrange',
    rows: [['Space', 'Play / stop'], ['Home / Enter', 'Playhead to bar 1'], ['Click the ruler', 'Move the playhead'],
      ['Drag on the ruler', 'Set the loop region'], ['L', 'Loop on / off'],
      ['Click, ⇧-click, drag on empty space', 'Select clips'], ['⌘A', 'Select all'],
      ['Drag', 'Move / resize (snaps to the grid: finer when zoomed in, down to 16ths)'],
      ['⌥ while dragging', 'Snap 4× finer'], ['⌥ when clicking, then drag', 'Copy'],
      ['Drag a clip edge', 'Extend (repeats) / trim'], ['R / ⌘D', 'Duplicate after the selection (or the selected section)'],
      ['← / →', 'Nudge a bar (⌥: a beat)'], ['⌫', 'Delete'], ['⌘Z / ⇧⌘Z', 'Undo / redo'],
      ['Double-click a pattern', 'Step editor (click cycles full → medium → soft → off)'],
      ['Drag in the top band', 'Add a section marker; click it to select its clips'],
      ['⌘-scroll / pinch', 'Zoom']],
  },
]

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose} width={640}>
      <div className="space-y-5">
        {SECTIONS.map((s) => (
          <section key={s.title}>
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-faint mb-1.5">{s.title}</h3>
            <table className="w-full text-[12.5px]">
              <tbody>
                {s.rows.map(([k, v]) => (
                  <tr key={k} className="border-b border-line/70 last:border-0">
                    <td className="py-1.5 pr-4 w-[44%]"><kbd className="font-mono text-[11.5px] rounded bg-raised px-1.5 py-0.5 text-accent">{k}</kbd></td>
                    <td className="py-1.5 text-muted">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </Modal>
  )
}
