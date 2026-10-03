/**
 * components/discover/DiscoverSources.tsx — the feeds Athena reads for article
 * discovery: grouped by vendor, with when each was last checked, how many new
 * articles it found, any error, an on/off switch, and a form to add another.
 */
import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineLoading } from '@carbon/react';
import { Close, Renew } from '@carbon/icons-react';
import { api } from '../../services/api';
import type { DiscoveryFeed } from '../../services/api';

const GROUPS = ['Microsoft', 'GitHub', 'IBM', 'Google', 'AWS', 'OpenAI', 'Analysts and media', 'Other'];

function ago(iso: string | null): string {
  if (iso === null) return 'never';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 2) return 'just now';
  if (mins < 90) return `${mins.toString()} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 36 ? `${hours.toString()} h ago` : `${Math.round(hours / 24).toString()} days ago`;
}

export const DiscoverSources: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [feedUrl, setFeedUrl] = useState('');
  const [group, setGroup] = useState('Other');
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const feeds = useQuery({
    queryKey: ['discovery-feeds'],
    queryFn: async () => { const r = await api.listDiscoveryFeeds(); return r.success ? r.data : []; },
  });
  const refresh = (): void => { void queryClient.invalidateQueries({ queryKey: ['discovery-feeds'] }); };

  const byGroup = new Map<string, DiscoveryFeed[]>();
  for (const f of feeds.data ?? []) byGroup.set(f.groupName, [...(byGroup.get(f.groupName) ?? []), f]);
  const groups = [...byGroup.keys()].sort((a, b) => GROUPS.indexOf(a) - GROUPS.indexOf(b));

  async function add(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setAdding(true);
    setMessage(null);
    const r = await api.addDiscoveryFeed({ title: title.trim(), feedUrl: feedUrl.trim(), groupName: group });
    setAdding(false);
    if (!r.success) { setMessage({ text: r.error.message, error: true }); return; }
    setTitle(''); setFeedUrl('');
    setMessage({ text: `Added “${r.data.title}” — ${r.data.itemsInFeed.toString()} articles in its feed. They appear after the next check.`, error: false });
    refresh();
  }

  return (
    <section className="dc-sources" aria-label="Discovery sources">
      <div className="dc-sources__head">
        <h2 className="dc-sources__title">Where Athena looks for articles</h2>
        <button type="button" className="dc-sources__btn" onClick={() => { void api.checkDiscoveryFeeds().then(() => { setMessage({ text: 'Checking every source now — new articles appear in a minute or two.', error: false }); window.setTimeout(refresh, 4_000); }); }}>
          <Renew size={14} aria-hidden="true" /> Check now
        </button>
        <button type="button" className="dc-sources__close" onClick={onClose} aria-label="Close sources"><Close size={16} /></button>
      </div>

      {feeds.isLoading && <InlineLoading description="Loading sources…" />}
      {groups.map((g) => (
        <div key={g} className="dc-sources__group">
          <h3 className="dc-sources__group-name">{g}</h3>
          <ul className="dc-sources__list">
            {(byGroup.get(g) ?? []).map((f) => (
              <li key={f.id} className={`dc-sources__item${f.isActive ? '' : ' dc-sources__item--off'}`}>
                <label className="dc-sources__switch" title={f.isActive ? 'Reading this source — click to pause' : 'Paused — click to read it again'}>
                  <input type="checkbox" checked={f.isActive} onChange={(e) => { void api.updateDiscoveryFeed(f.id, { isActive: e.target.checked }).then(refresh); }} />
                  <span className="cds--visually-hidden">Read {f.title}</span>
                </label>
                <span className="dc-sources__name">{f.title}</span>
                <span className={`dc-sources__status${f.lastError !== null ? ' dc-sources__status--error' : ''}`} title={f.lastError ?? f.feedUrl}>
                  {f.lastError !== null ? `Problem: ${f.lastError}` : `checked ${ago(f.lastCheckedAt)}${f.lastCheckedAt !== null ? ` · ${f.lastNewCount.toString()} new` : ''}`}
                </span>
                <button
                  type="button" className="dc-sources__remove" aria-label={`Remove ${f.title}`} title="Stop reading this source (its articles stay)"
                  onClick={() => { if (window.confirm(`Stop reading “${f.title}”? Articles already found stay in Discover.`)) void api.deleteDiscoveryFeed(f.id).then(refresh); }}
                >
                  <Close size={12} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}

      <form className="dc-sources__add" onSubmit={(e) => { void add(e); }}>
        <input className="dc-sources__input" placeholder="Name, e.g. Anthropic News" value={title} onChange={(e) => { setTitle(e.target.value); }} aria-label="Source name" required />
        <input className="dc-sources__input dc-sources__input--wide" placeholder="Feed address (RSS or Atom), https://…" value={feedUrl} onChange={(e) => { setFeedUrl(e.target.value); }} aria-label="Feed address" required />
        <select className="dc-sources__input" value={group} onChange={(e) => { setGroup(e.target.value); }} aria-label="Group">
          {GROUPS.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
        <button type="submit" className="dc-sources__btn dc-sources__btn--primary" disabled={adding || title.trim() === '' || feedUrl.trim() === ''}>{adding ? 'Checking…' : 'Add source'}</button>
      </form>
      {message !== null && <p className={`dc-sources__msg${message.error ? ' dc-sources__msg--error' : ''}`} role="status">{message.text}</p>}
    </section>
  );
};
