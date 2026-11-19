import { GENRE_LABELS } from '../lib/format'
import { PAGE_TABS, pageOf, useApp, type View } from '../store/app'
import { DEFAULT_GENRE } from '../types/engine'
import { cx, PageTitle } from './ui'

const TITLES = { create: 'Create', drums: 'Drums', sounds: 'Sounds', upload: 'Upload', settings: 'Settings' } as const

/**
 * A page's title and its tabs (SCOPE.md §6.1): Drums (Drumvault, Library), Sounds (Chord Stabs,
 * Drop Hits, Strings, Bass Samples, Ambience, MIDI). A view that isn't a tab (Grid, Splice) shows
 * its own name, with the way back to the page's tabs.
 */
export function PageTabs({ view, title }: { view: View; title?: string }) {
  const setView = useApp((s) => s.setView)
  const openPage = useApp((s) => s.openPage)
  const page = pageOf(view)
  const tabs = PAGE_TABS[page]
  const isTab = tabs.some((t) => t.view === view)
  const genre = useApp((s) => s.settings?.genre ?? DEFAULT_GENRE)
  // The library's pages show the active genre's sources, and what's imported on them is of it (vocals are every genre's).
  const ofGenre = (page === 'drums' || page === 'sounds') && view !== 'vocalloops'
  return (
    <div className="flex items-center gap-4 min-w-0">
      <PageTitle>{TITLES[page]}</PageTitle>
      {ofGenre && (
        <span className="shrink-0 h-6 px-2.5 rounded-full flex items-center text-[11.5px] font-medium text-accent bg-accent/15"
              title={`This page shows your ${GENRE_LABELS[genre]} sounds, and what you import here is tagged ${GENRE_LABELS[genre]}. Change the genre in Create's top bar.`}>
          {GENRE_LABELS[genre]}
        </span>
      )}
      {isTab ? tabs.length > 1 && (
        <nav className="app-no-drag flex items-center gap-1 rounded-xl bg-[rgb(0_0_0/0.22)] p-1 min-w-0 overflow-x-auto">
          {tabs.map((t) => (
            <button key={t.view} onClick={() => setView(t.view)} aria-current={t.view === view ? 'page' : undefined}
                    className={cx('h-7 px-3 rounded-lg text-[12.5px] whitespace-nowrap transition-colors',
                      t.view === view ? 'bg-raised text-text font-medium' : 'text-muted hover:text-text')}>
              {t.label}
            </button>
          ))}
        </nav>
      ) : (
        <span className="app-no-drag flex items-center gap-2 text-[12.5px]">
          <button className="h-7 px-2.5 rounded-lg text-muted hover:text-text hover:bg-raised" onClick={() => openPage(page)}
                  title={`Back to ${TITLES[page]}`}>‹ {TITLES[page]}</button>
          <span className="text-text font-medium">{title}</span>
        </span>
      )}
    </div>
  )
}
