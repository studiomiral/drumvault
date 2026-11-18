// House of Tracks' upload form (SCOPE.md §6.5b): its address, every selector the app fills, and
// the scripts run in the page. When the site changes, this is the one file to fix.
// Plain TypeScript (no Electron imports) so it can be tested on its own.
//
// Read from the form's step 1 ("Files and Information", Nov 2026; a Next.js/React page). Step 2
// ("Check and Confirm") and its Submit button are the user's: the app never presses "Next step"
// or submits.

import type { HotFields } from '../src/types/api'

export const HOT_UPLOAD_URL = 'https://houseoftracks.com/uploadtracks'
/** The window's own session: the login is kept between runs, apart from the app's. */
export const HOT_PARTITION = 'persist:houseoftracks'

/** Only houseoftracks.com (and its subdomains) loads in the window, over https. */
export function isHotUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && (u.hostname === 'houseoftracks.com' || u.hostname.endsWith('.houseoftracks.com'))
  } catch {
    return false
  }
}

/** The form's fields. Text, number and select fields by id; the radio groups by name. */
export const HOT_SELECTORS = {
  /** There once the form is on screen (else: the login page, or still loading). */
  ready: '#trackname',
  trackName: '#trackname',
  bpm: '#bpm',
  key: '#key',
  genre: '#genre',
  description: '#description',
  price: '#price',
  instrument: '#mainInstrument',
  lyrics: '#tracks_lyrics',
  /** Radio groups (input[name=…]): "This Track Contains", "Vocal Category". */
  vocal: 'vocal',
  vocalCategory: 'vocalcategory',
  /** Tags: a multiselect-react-dropdown; its options are <li>s, the chosen ones chips. */
  tagsInput: '#tags_input',
  tagOption: '#tags li.option',
  tagChip: '#tags .chip',
} as const

/** The file inputs, by what goes in them (WAVs and the two zips). */
export const HOT_FILE_INPUTS = {
  master: '#file-upload-master',
  masterInstrumental: '#file-upload-instrumental_master',
  mixdown: '#file-upload-mixdown',
  mixdownInstrumental: '#file-upload-instrumental_mixdown',
  stems: '#file-upload-stems',
  midi: '#file-upload-midi',
} as const
export type HotFileInput = keyof typeof HOT_FILE_INPUTS

export const HOT_FILE_LABELS: Record<HotFileInput, string> = {
  master: 'Master', masterInstrumental: 'Master Instrumental', mixdown: 'Mixdown', mixdownInstrumental: 'Mixdown Instrumental',
  stems: 'Stems Folder (zip)', midi: 'Midi Folder (zip)',
}

const SHARP_FLAT: Record<string, string> = {
  'C#': 'C♯/D♭', Db: 'C♯/D♭', 'D#': 'D♯/E♭', Eb: 'D♯/E♭', 'F#': 'F♯/G♭', Gb: 'F♯/G♭',
  'G#': 'G♯/A♭', Ab: 'G♯/A♭', 'A#': 'A♯/B♭', Bb: 'A♯/B♭',
}

/** The key select's value for info.txt's key: "F# minor" → "F♯/G♭ Minor"; null for "none" or one it can't read. */
export function hotKey(key: string): string | null {
  const m = /^([A-G][#b]?) (major|minor)$/i.exec(key.trim())
  if (!m) return null
  const root = SHARP_FLAT[m[1]] ?? m[1]
  return `${root} ${m[2][0].toUpperCase()}${m[2].slice(1).toLowerCase()}`
}

/**
 * The script that fills the form (or, `verify`, only reads it back), run in the page with
 * executeJavaScript. Values are set through the elements' native setters with `input` and `change`
 * events, so React sees them; radios and tag options are clicked. Resolves to one row per field.
 */
export function fillScript(fields: HotFields, verify: boolean): string {
  const key = hotKey(fields.key)
  const values = { ...fields, hotKey: key, bpm: String(Math.round(Number(fields.bpm))) }
  return `(${PAGE_FILL})(${JSON.stringify(HOT_SELECTORS)}, ${JSON.stringify(values)}, ${verify})`
}

// Plain JavaScript (it runs in the page, not in the app).
const PAGE_FILL = String.raw`async (S, V, verify) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const rows = []
  const row = (field, value, ok, note) => rows.push(note ? { field, value: String(value), ok, note } : { field, value: String(value), ok })
  const q = (s) => document.querySelector(s)
  const norm = (t) => String(t ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
  const setValue = (el, v) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const missing = (field, value, sel) => row(field, value, false, 'not found on the page (' + sel + ')')

  const text = (field, sel, v) => {
    const el = q(sel)
    if (!el) return missing(field, v, sel)
    if (!verify) setValue(el, v)
    row(field, v, el.value === v, el.value === v ? undefined : 'the page has "' + el.value.slice(0, 60) + '"')
  }
  const select = (field, sel, label, match) => {
    const el = q(sel)
    if (!el) return missing(field, label, sel)
    const opt = [...el.options].find((o) => o.value && match(o))
    if (!opt) {
      const has = [...el.options].filter((o) => o.value).map((o) => o.text.trim())
      return row(field, label, false, 'the form has no "' + label + '" (it has: ' + has.slice(0, 30).join(', ') + ')')
    }
    if (!verify) setValue(el, opt.value)
    row(field, label, el.value === opt.value, el.value === opt.value ? undefined : 'the page has "' + (el.selectedOptions[0]?.text ?? '') + '"')
  }
  const radio = (field, name, value) => {
    const all = [...document.querySelectorAll('input[type="radio"][name="' + name + '"]')]
    if (!all.length) return missing(field, value, 'input[name=' + name + ']')
    const el = all.find((r) => norm(r.value) === norm(value))
    if (!el) return row(field, value, false, 'the form has no "' + value + '" (it has: ' + all.map((r) => r.value).join(', ') + ')')
    if (!verify && !el.checked) el.click()
    row(field, value, el.checked, el.checked ? undefined : 'not checked')
  }
  const tags = async (wanted) => {
    const label = wanted.join(', ')
    const input = q(S.tagsInput)
    if (!input) return missing('Tags', label, S.tagsInput)
    const chosen = () => [...document.querySelectorAll(S.tagChip)].map((c) => norm(c.textContent))
    const unknown = []
    if (!verify) {
      for (const t of wanted) {
        if (chosen().includes(norm(t))) continue
        input.focus()
        input.click()
        await sleep(80)
        const li = [...document.querySelectorAll(S.tagOption)].find((l) => norm(l.textContent) === norm(t))
        if (!li) { unknown.push(t); continue }
        li.click()
        await sleep(80)
      }
      input.blur()
    }
    const now = chosen()
    const notSet = wanted.filter((t) => !now.includes(norm(t)))
    const extra = now.filter((t) => !wanted.some((w) => norm(w) === t))
    const notes = []
    if (unknown.length) notes.push('the form has no tag ' + unknown.join(', '))
    else if (notSet.length) notes.push('not set: ' + notSet.join(', '))
    if (extra.length) notes.push('also chosen: ' + extra.join(', '))
    row('Tags', label, !notSet.length && !extra.length, notes.join('; ') || undefined)
  }

  // The radios first: what the track contains may show or hide other fields.
  radio('Vocals', S.vocal, V.vocal)
  radio('Vocal category', S.vocalCategory, V.vocalCategory)
  if (!verify) await sleep(250)
  text('Track name', S.trackName, V.trackName)
  text('BPM', S.bpm, V.bpm)
  if (V.hotKey) select('Key', S.key, V.key, (o) => o.value === V.hotKey)
  else row('Key', V.key, false, 'no key to choose: pick one by hand')
  select('Genre', S.genre, V.genre, (o) => norm(o.text) === norm(V.genre))
  await tags(V.tags)
  text('Description', S.description, V.description)
  select('Price', S.price, '€' + V.price, (o) => o.text.replace(/\D/g, '') === String(V.price))
  select('Main instrument', S.instrument, V.instrument, (o) => norm(o.text) === norm(V.instrument))
  if (V.lyrics) text('Lyrics', S.lyrics, V.lyrics)
  return rows
}`

/** Whether the form is on screen and React has taken it over (its props on the element), so set values stick. */
export const READY_SCRIPT = `(() => { const el = document.querySelector(${JSON.stringify(HOT_SELECTORS.ready)}); return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps')) })()`

/** The file a file input holds now (its name), or null. */
export function fileNameScript(input: HotFileInput): string {
  return `(() => { const el = document.querySelector(${JSON.stringify(HOT_FILE_INPUTS[input])}); return el && el.files && el.files[0] ? el.files[0].name : null })()`
}

/**
 * Dev only (the "Dump form" action): every input, select, textarea and button on the page as JSON,
 * with a selector for each, to map the form from. Password values are never read.
 */
export const DUMP_SCRIPT = String.raw`(() => {
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s)
  const clean = (t) => String(t ?? '').replace(/\s+/g, ' ').trim()
  const selector = (el) => {
    if (el.id && document.querySelectorAll('#' + esc(el.id)).length === 1) return '#' + esc(el.id)
    if (el.name) {
      const s = el.tagName.toLowerCase() + '[name="' + el.name + '"]' + (el.type === 'radio' || el.type === 'checkbox' ? '[value="' + el.value + '"]' : '')
      if (document.querySelectorAll(s).length === 1) return s
    }
    const path = []
    for (let n = el; n && n.nodeType === 1 && n !== document.body; n = n.parentElement) {
      if (n.id) { path.unshift('#' + esc(n.id)); break }
      const same = [...(n.parentElement?.children ?? [])].filter((c) => c.tagName === n.tagName)
      path.unshift(n.tagName.toLowerCase() + (same.length > 1 ? ':nth-of-type(' + (same.indexOf(n) + 1) + ')' : ''))
    }
    return path.join(' > ')
  }
  const labelOf = (el) => {
    const byFor = el.id ? document.querySelector('label[for="' + esc(el.id) + '"]') : null
    if (byFor) return clean(byFor.textContent)
    const wrap = el.closest('label')
    if (wrap) return clean(wrap.textContent)
    const by = el.getAttribute('aria-labelledby')
    if (by) return clean(by.split(' ').map((id) => document.getElementById(id)?.textContent).join(' '))
    const legend = el.closest('fieldset')?.querySelector('legend')
    if (legend) return clean(legend.textContent)
    const box = el.closest('[class*="audioFile"], [class*="AudioFile"]')
    if (box) return clean(box.querySelector('[class*="title"], [class*="Title"]')?.textContent)
    return ''
  }
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
  const fields = [...document.querySelectorAll('input, select, textarea')].map((el) => ({
    tag: el.tagName.toLowerCase(),
    type: el.type || null,
    name: el.name || null,
    id: el.id || null,
    label: labelOf(el),
    placeholder: el.placeholder || null,
    value: el.type === 'password' || el.type === 'file' ? null : el.value,
    checked: el.type === 'radio' || el.type === 'checkbox' ? el.checked : undefined,
    files: el.type === 'file' ? [...(el.files ?? [])].map((f) => f.name) : undefined,
    accept: el.accept || undefined,
    required: el.required || undefined,
    disabled: el.disabled || undefined,
    visible: visible(el),
    options: el.tagName === 'SELECT' ? [...el.options].map((o) => ({ value: o.value, text: clean(o.text), group: o.parentElement?.tagName === 'OPTGROUP' ? o.parentElement.label : undefined })) : undefined,
    selector: selector(el),
  }))
  const listOptions = [...document.querySelectorAll('.multiSelectContainer')].map((m) => ({
    selector: selector(m),
    options: [...m.querySelectorAll('li.option')].map((li) => clean(li.textContent)),
    chosen: [...m.querySelectorAll('.chip')].map((c) => clean(c.textContent)),
  }))
  const buttons = [...document.querySelectorAll('button')].map((b) => ({ text: clean(b.textContent), selector: selector(b), visible: visible(b) })).filter((b) => b.text)
  const headings = [...document.querySelectorAll('h1, h2, h3, h4, legend, label')].map((h) => clean(h.textContent)).filter(Boolean)
  return { url: location.href, title: document.title, at: new Date().toISOString(), fields, multiselects: listOptions, buttons, headings }
})()`
