import React, { useEffect, useState } from 'react';
import './diagramIntegration.scss';

interface IconEntry { name: string; family: string; path: string }

export function DiagramIconPicker({ onPick }: { onPick: (file: File) => void }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [icons, setIcons] = useState<IconEntry[]>([]);
  const [query, setQuery] = useState('');
  const [family, setFamily] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setError(null);
    setBusy(true);
    void fetch('/diagram-icons/catalog.json', { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(`Icon catalog returned HTTP ${r.status}`);
        const rows: unknown = await r.json();
        if (!Array.isArray(rows) || !rows.every((entry: unknown) => {
          if (entry === null || typeof entry !== 'object') return false;
          const row = entry as Record<string, unknown>;
          return typeof row['name'] === 'string' && typeof row['family'] === 'string'
            && typeof row['path'] === 'string' && /^\/diagram-icons\/[a-z0-9-]+\.svg$/.test(row['path']);
        })) throw new Error('Icon catalog is invalid');
        setIcons(rows as IconEntry[]);
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Could not load icon catalog');
      })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => { controller.abort(); };
  }, [open, attempt]);
  async function pick(icon: IconEntry): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(icon.path);
      if (!response.ok) throw new Error(`Could not load ${icon.name}: HTTP ${response.status}`);
      const blob = await response.blob();
      onPick(new File([blob], `${icon.name}.svg`, { type: 'image/svg+xml' }));
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not insert icon');
    } finally { setBusy(false); }
  }
  const matches = icons.filter((icon) => (family === '' || icon.family === family)
    && `${icon.name} ${icon.family}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="dg-icons">
    <button type="button" aria-expanded={open} onClick={() => { setOpen(!open); }}>Microsoft icons</button>
    {open && <section className="dg-icons__panel" aria-label="Microsoft architecture icons">
      <div className="dg-icons__heading"><strong>Microsoft icons</strong><button type="button" aria-label="Close icon picker" onClick={() => { setOpen(false); }}>Close</button></div>
      <label>Search icons<input value={query} onChange={(e) => { setQuery(e.target.value); }} autoFocus placeholder="Foundry, storage, Power Apps..." /></label>
      <label>Icon family<select value={family} onChange={(e) => { setFamily(e.target.value); }}>
        <option value="">All families</option>
        {[...new Set(icons.map((icon) => icon.family))].map((name) => <option key={name}>{name}</option>)}
      </select></label>
      {error !== null && <p role="alert">{error} <button type="button" onClick={() => { setAttempt(attempt + 1); }}>Retry</button></p>}
      {busy && <p role="status">Loading icons...</p>}
      <div className="dg-icons__grid">{matches.map((icon) => <button key={icon.path} type="button" disabled={busy} title={`${icon.name} (${icon.family})`} onClick={() => { void pick(icon); }}>
        <img src={icon.path} alt="" /><span>{icon.name}</span>
      </button>)}</div>
      {!busy && error === null && matches.length === 0 && <p>No matching icons. Paste or upload an icon instead.</p>}
      <p className="dg-icons__terms">For architecture diagrams, training and documentation. <a href="/diagram-icons/NOTICE.txt" target="_blank" rel="noreferrer">Sources and terms</a>. Microsoft 365 entries are architecture symbols, not current product logos.</p>
    </section>}
  </div>;
}
