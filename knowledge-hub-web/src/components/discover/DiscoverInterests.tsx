import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../services/api';
import { requireApiData } from '../../services/apiError';
import { DataNotice } from '../DataNotice';
import { AppDialog } from '../AppDialog';
import type { InterestWeight } from '../../types/watchlists';
import '../../styles/discoverWatchlists.scss';

export const DiscoverInterests: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const client = useQueryClient();
  const [kind, setKind] = useState<InterestWeight['kind']>('topic');
  const [term, setTerm] = useState('');
  const [weight, setWeight] = useState(1);
  const [filtered, setFiltered] = useState(false);
  const [page, setPage] = useState(1);
  const weights = useQuery({ queryKey: ['discover-interests'], queryFn: async () => requireApiData(await api.getDiscoverInterests()) });
  const sources = useQuery({ queryKey: ['discover-source-names'], queryFn: async () => requireApiData(await api.getDiscoverSources()) });
  const excluded = useQuery({ queryKey: ['discover-filtered', page], queryFn: async () => requireApiData(await api.getFilteredDiscover(page)), enabled: filtered });
  const save = useMutation({
    mutationFn: async (value: InterestWeight) => requireApiData(await api.saveDiscoverInterest(value)),
    onSuccess: data => { client.setQueryData(['discover-interests'], data); void client.invalidateQueries({ queryKey: ['discover'] }); void client.invalidateQueries({ queryKey: ['discover-filtered'] }); },
  });
  return <AppDialog wide title="Discover interests and pick reasons" onClose={onClose}
    actions={<button type="button" className="dw-button" onClick={onClose}>Done</button>}>
    <div className="dw-form">
      <p className="dw-hint">Weights are saved to your account on the server and apply across browsers. 0 filters a topic or source out of For you, 1 is neutral, 2 boosts it. Pick reasons are available in every article’s Explore panel.</p>
      {weights.isError && <DataNotice title="Interest weights unavailable" error={weights.error} />}
      {weights.isLoading && <p className="dw-hint" role="status">Loading saved interest weights…</p>}
      {kind === 'source' && sources.isError && <DataNotice title="Source names unavailable" error={sources.error} onRetry={() => { void sources.refetch(); }} />}
      {save.isError && <DataNotice title="Weight was not saved" error={save.error} />}
      <form className="dw-form" onSubmit={e => { e.preventDefault(); if (term.trim() && !save.isPending) save.mutate({ kind, term: term.trim(), weight }); }}>
        <label className="dw-field">Interest type<select value={kind} onChange={e => { setKind(e.target.value as InterestWeight['kind']); setTerm(''); }}>
          <option value="topic">Topic</option><option value="source">Source</option>
        </select></label>
        <label className="dw-field">{kind === 'topic' ? 'Topic text' : 'Source name'}
          {kind === 'topic' ? <input required maxLength={128} value={term} onChange={e => setTerm(e.target.value)} />
            : <select required value={term} onChange={e => setTerm(e.target.value)}><option value="">Choose source…</option>
              {sources.data?.map(s => <option key={s.title} value={s.title.toLowerCase()}>{s.title}</option>)}</select>}
        </label>
        <label className="dw-field">Weight (0–2)<input type="number" min={0} max={2} step={0.1} value={weight} onChange={e => setWeight(Number(e.target.value))} /></label>
        <button className="dw-button dw-button--primary" type="submit" disabled={!term.trim() || save.isPending || weights.isLoading || weights.isError}>{save.isPending ? 'Saving…' : 'Save weight'}</button>
      </form>
      <ul className="dw-weights">{weights.data?.map(w => <li key={`${w.kind}:${w.term}`}><span>{w.kind}: {w.term} ×{w.weight}</span>
        <button type="button" className="dw-button" disabled={save.isPending} onClick={() => { setKind(w.kind); setTerm(w.term); setWeight(w.weight); }}>Edit</button>
        <button type="button" className="dw-button" disabled={save.isPending || w.weight === 1} onClick={() => save.mutate({ ...w, weight: 1 })}>Reset to 1</button>
      </li>)}</ul>
      <button type="button" className="dw-button" aria-expanded={filtered} onClick={() => setFiltered(v => !v)}>What was filtered out this week?</button>
      {filtered && <section aria-label="Filtered articles" className="dw-filtered">
        <p className="dw-hint">Articles from the last seven days shelved or archived during triage, or excluded by a zero interest weight.</p>
        {excluded.isError && <DataNotice title="Filtered articles unavailable" error={excluded.error} />}
        {excluded.isLoading && <p className="dw-hint" role="status">Loading filtered articles…</p>}
        {excluded.data?.total === 0 && <p className="dw-empty">No filtered articles this week.</p>}
        {excluded.data?.items.map(item => <article className="dw-filtered-item" key={item.id}>
          <h3>{item.url ? <a href={item.url} target="_blank" rel="noreferrer">{item.title}</a> : item.title}</h3>
          <p>{item.filteredReason}</p>
        </article>)}
        {excluded.data && excluded.data.total > 100 && <div className="dw-actions" aria-label="Filtered article pages">
          <button type="button" className="dw-button" disabled={page === 1} onClick={() => setPage(p => p - 1)}>Previous</button>
          <span className="dw-hint">Page {page} of {Math.ceil(excluded.data.total / 100)}</span>
          <button type="button" className="dw-button" disabled={page * 100 >= excluded.data.total} onClick={() => setPage(p => p + 1)}>Next</button>
        </div>}
      </section>}
    </div>
  </AppDialog>;
};
