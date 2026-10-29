# Keys system

Branch: `codex/keys-system`, based on `7720739` (the committed Serum bass module).
Worktree: `/private/tmp/drumvault-keys`.

Keys sits beside Bass in Generate (stacked below it on narrow windows), with an independent
on/off setting, Serum 2 preset pool and favorites, Any/1/2/4-bar generation, transpose,
piano roll, save-to-library action, sidechain and keep-part/keep-patch toggles. The Keys lane
is directly after Bass. It plays in drops, varies in breakdowns and builds, and leaves DJ
intros/outros clear. Arrange supports note edits, patch changes, regeneration and transpose.
Exports contain a separate Keys WAV stem and `<prefix>_Keys.mid`.

The MIDI importer keeps key/keys, keyboard, piano, organ, Rhodes, Wurli, clav and chord parts
as `role: keys`, alongside bass. Reimport existing MIDI packs to collect parts the old importer
left out; existing bass files are skipped. MIDI's role dropdown can correct classification.
Select the desired patch folders in Settings → Keys, independently of Settings → Bass.

The seeded polyphonic learner (`app/src/generate/keys.ts`) groups simultaneous notes into
voicings, preserves inversions/extensions and per-voice lengths/velocity, and recombines
learned rhythms with harmonic phrases in the track key and learned register. Saved Keys
MIDI joins the same training pool as imports. A very small pool naturally limits variation.

Keys reuses the existing Serum host, scheduler, piano roll and project clip representation.
The existing `AudioClip.bass` render field now carries an optional `role` and `keyLabel`;
missing role means bass, preserving older projects. Keys renders use `.drumvault/keys/`.
Render status, note editing, patch selection and MIDI export stay separate by role.
No database migration or additional plugin installation is needed.

## Merge notes

This branch does not contain Claude's uncommitted changes. Merge after those changes are
committed. Shared integration points include GenerateView, API types, Electron main, MIDI
import and settings. Keep Claude's newer Module wrapper/layout and place KeysPanel beside
the Bass module when resolving GenerateView; retain both modules' imports and keep toggles.

## Validation

- Engine: 259 tests passed, including real Serum 2 rendering of polyphonic Keys notes.
- App: 143 tests passed (13 engine-dependent tests skipped in the quick suite); typecheck and production build passed.
- Full app integration: the sidecar startup test timed out in this execution environment;
  engine RPC/Serum tests pass independently. Native UI verification remains incomplete
  because the app selector bound to the existing Drumvault process instead of the isolated
  preview; no changes were made through that existing app.
