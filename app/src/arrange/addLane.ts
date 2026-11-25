// Adding a lane (SCOPE.md §6.6, "Adding a lane"): the menu the + next to undo / redo and a right-click
// in the lane column's empty space open. On a generated track each kind is filled and mixed as the
// generator does it; an empty lane is there on any track.

import type { MenuEntry } from '../components/ContextMenu'
import { ADDABLE } from '../generate/generator'
import { makeLane } from '../lib/project'
import { useApp } from '../store/app'
import { addTrackLane } from '../store/generate'
import { useProject } from '../store/project'

/** The kinds of lane to add, then an empty one. */
export function addLaneMenu(): MenuEntry[] {
  const generated = !!useProject.getState().project.generation
  const kinds: MenuEntry[] = ADDABLE.map(({ role, label }) => ({
    label,
    disabled: !generated,
    title: generated ? `A ${label.toLowerCase()} lane, written and mixed the way the generator does it (⌘Z undoes)` : 'Only on a generated track',
    onClick: () => {
      if (!addTrackLane(role)) useApp.getState().toast('info', `No ${label.toLowerCase()} came out: the library has nothing else of the kind for this track.`)
    },
  }))
  return [...kinds, 'separator', {
    label: 'Empty lane', title: 'A lane to fill yourself, from the Library panel',
    onClick: () => useProject.getState().edit('Add lane', (d) => {
      d.lanes.push(makeLane(`Lane ${d.lanes.length + 1}`, d.lanes.length))
    }),
  }]
}
