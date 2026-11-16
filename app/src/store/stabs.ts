// Chord stab settings (SCOPE.md §6.9): the rhythms saved in Generate's step sequencer, that new
// tracks take or learn their stab rhythm from. The stabs themselves are the Chord Stabs page's samples.

import type { StabsSettings } from '../types/api'
import { useApp } from './app'

export function stabsSettings(): StabsSettings {
  return { ...useApp.getState().settings?.stabs }
}

export async function saveStabsSettings(patch: Partial<StabsSettings>): Promise<void> {
  await useApp.getState().saveSettings({ stabs: { ...stabsSettings(), ...patch } })
}
