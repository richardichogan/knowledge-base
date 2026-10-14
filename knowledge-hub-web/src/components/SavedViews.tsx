import React, { useEffect, useId, useRef, useState } from 'react';
import { Bookmark } from '@carbon/icons-react';
import { useLocation } from 'react-router-dom';
import { DataNotice } from './DataNotice';
import { confirmDialog } from '../services/appDialogs';
import { parseSavedViews, parseSharedView, parseWorkspaceView, SAVED_VIEWS_KEY, sharedViewUrl, type SavedView, type WorkspaceView } from '../utils/savedViews';

/** `menu` renders a compact header button with a dropdown panel instead of an inline disclosure. */
export const SavedViews: React.FC<{ current: WorkspaceView; onApply: (view: WorkspaceView) => void; variant?: 'inline' | 'menu' }> = ({ current, onApply, variant = 'inline' }) => {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (variant !== 'menu') return undefined;
    const close = (event: MouseEvent): void => {
      const el = detailsRef.current;
      if (el?.open && !el.contains(event.target as Node)) el.open = false;
    };
    document.addEventListener('mousedown', close);
    return () => { document.removeEventListener('mousedown', close); };
  }, [variant]);
  const id = useId();
  const location = useLocation();
  const apply = useRef(onApply);
  apply.current = onApply;
  const [loaded] = useState(() => {
    try { return { items: parseSavedViews(localStorage.getItem(SAVED_VIEWS_KEY)), error: null }; }
    catch (error) { console.warn('[Views] Could not read device-local saved views.', error); return { items: [], error }; }
  });
  const [items, setItems] = useState<SavedView[]>(loaded.items);
  const [error, setError] = useState<unknown>(loaded.error);
  const [linkError, setLinkError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [name, setName] = useState('');
  const [selected, setSelected] = useState('');

  useEffect(() => {
    try {
      setLinkError(null);
      const shared = parseSharedView(location.search, current.kind);
      if (shared) { apply.current(shared); setNotice('Shared view applied. Filters only; no content was changed.'); }
    } catch (failure) { console.warn('[Views] Invalid shared view.', failure); setLinkError(failure); }
  }, [location.search, current.kind]);

  function persist(next: SavedView[]): void {
    const raw = JSON.stringify({ version: 1, items: next });
    parseSavedViews(raw);
    localStorage.setItem(SAVED_VIEWS_KEY, raw);
    setItems(next);
    setError(null);
  }

  function save(event: React.FormEvent): void {
    event.preventDefault();
    setNotice('');
    try {
      // Re-read so a save cannot overwrite views added in another tab.
      const latest = parseSavedViews(localStorage.getItem(SAVED_VIEWS_KEY));
      const view = parseWorkspaceView(current);
      const existing = latest.find(item => item.view.kind === view.kind && item.name.toLocaleLowerCase('en-GB') === name.trim().toLocaleLowerCase('en-GB'));
      const entry = { id: existing?.id ?? crypto.randomUUID(), name: name.trim(), view };
      persist([...latest.filter(item => item.id !== entry.id), entry]);
      setSelected(entry.id);
      setNotice('View saved on this device.');
    } catch (failure) { console.warn('[Views] Save failed.', failure); setError(failure); }
  }

  return (
    <>
      {linkError != null && <DataNotice title="Shared view link is invalid; current filters were retained" error={linkError} />}
      {error != null && <DataNotice title="View could not be loaded or saved" error={error} />}
      <details ref={detailsRef} className={`kh-saved-views${variant === 'menu' ? ' kh-saved-views--menu' : ''}`}
        onKeyDown={event => { if (variant === 'menu' && event.key === 'Escape' && detailsRef.current) { detailsRef.current.open = false; detailsRef.current.querySelector('summary')?.focus(); } }}>
      <summary title="Saved views">{variant === 'menu' ? <><Bookmark size={16} aria-hidden="true" /> Views</> : 'Saved views'}</summary>
      <div className="kh-saved-views__body">
        <p>Filters and view mode only. Saved on this device; up to 20 views.</p>
        {loaded.error != null && error != null && <button type="button" onClick={() => {
          void (async () => {
            try {
              if (!await confirmDialog('Remove all saved Plan and Discover views on this device? Current filters and content will not change.',
                { title: 'Reset saved views', confirmLabel: 'Reset saved views', tone: 'danger' })) return;
              persist([]); setSelected(''); setNotice('Device-local saved views reset.');
            } catch (failure) { console.warn('[Views] Reset failed.', failure); setError(failure); }
          })();
        }}>Reset saved views</button>}
        <label htmlFor={`${id}-pick`}>Apply a saved view</label>
        <div className="kh-saved-views__row">
          <select id={`${id}-pick`} value={selected} onChange={event => {
            const entry = items.find(item => item.id === event.target.value && item.view.kind === current.kind);
            setSelected(entry?.id ?? '');
            if (entry) { setName(entry.name); onApply(entry.view); setNotice(`Applied ${entry.name}.`); }
          }}>
            <option value="">Choose a view</option>
            {items.filter(item => item.view.kind === current.kind).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <button type="button" disabled={!selected} onClick={() => {
            setNotice('');
            try {
              persist(parseSavedViews(localStorage.getItem(SAVED_VIEWS_KEY)).filter(item => item.id !== selected));
              setSelected(''); setNotice('Saved view deleted; current filters are unchanged.');
            } catch (failure) { console.warn('[Views] Delete failed.', failure); setError(failure); }
          }}>Delete view</button>
        </div>
        <form onSubmit={save}>
          <label htmlFor={`${id}-name`}>View name</label>
          <div className="kh-saved-views__row">
            <input id={`${id}-name`} value={name} maxLength={64} required onChange={event => setName(event.target.value)} />
            <button type="submit" disabled={!name.trim()}>Save current view</button>
          </div>
        </form>
        <p>Saving with the same name updates that view. Shared links include filter values, not articles or tasks.</p>
        <button type="button" onClick={() => {
          setNotice('');
          const url = new URL(location.pathname + location.search + location.hash, window.location.origin);
          void (async () => {
            try { await navigator.clipboard.writeText(sharedViewUrl(url, current)); setNotice('View link copied.'); }
            catch (failure) { console.warn('[Views] Link copy failed.', failure); setError(failure); }
          })();
        }}>Copy view link</button>
        {notice && <p role="status">{notice}</p>}
      </div>
      </details>
    </>
  );
};
