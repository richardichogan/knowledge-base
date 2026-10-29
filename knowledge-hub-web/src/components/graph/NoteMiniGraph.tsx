import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useGraphData } from '../../hooks/useGraphData';
import { DataNotice } from '../DataNotice';
import { AtlasForceMap } from './AtlasForceMap';
import { graphNodeHref, isInferred, neighbourhood } from './atlasModel';
import './atlas.scss';

export function NoteMiniGraph({ noteId }: { noteId: string }): React.ReactElement {
  const seed = `note:${noteId}`;
  const { data, isLoading, isError, error, retry } = useGraphData({ days: 3650, seed, depth: 2 });
  const [selected, setSelected] = useState<string | null>(null);
  const graph = useMemo(() => neighbourhood(data?.nodes ?? [], (data?.edges ?? []).filter(e => !isInferred(e)),
    seed, data?.nodes.length ?? 0, 2), [data, seed]);
  const chosen = graph.nodes.find(n => n.id === selected);
  return <section className="note-mini-graph" aria-label="Note knowledge graph">
    <div className="note-mini-graph__heading"><h2>Around this note</h2>
      <Link to={`/graph?seed=${encodeURIComponent(seed)}`}>Explore graph →</Link></div>
    {isLoading ? <p role="status">Loading connections…</p>
      : isError ? <DataNotice title="Note graph is unavailable" error={error} onRetry={() => { void retry(); }} />
        : graph.nodes.length <= 1 ? <p>No visible connections yet. Add a tag, link a project or mention another record to start a neighbourhood.</p>
          : <>
            <AtlasForceMap compact scope={seed} depth={2} nodes={graph.nodes} edges={graph.edges} selected={chosen?.id ?? seed}
              onSelect={node => { setSelected(node?.id ?? null); }} />
            {chosen && <div className="note-mini-graph__selection"><strong>{chosen.title}</strong><span>{chosen.refType}</span>
              <Link to={graphNodeHref(chosen)}>Open record</Link>
              <Link to={`/graph?seed=${encodeURIComponent(chosen.id)}`}>Explore from here</Link></div>}
            <details><summary>Browse connected records</summary>
              <ul>{graph.nodes.filter(n => n.id !== seed).map(n => <li key={n.id}>
                <button type="button" className="note-mini-graph__record" aria-pressed={selected === n.id}
                  onClick={() => { setSelected(n.id); }}>{n.title}</button>
                <span>{n.refType}</span> <Link to={graphNodeHref(n)}>Open record</Link>
              </li>)}</ul>
            </details>
            {data?.stats.truncated && <p>Showing a partial neighbourhood. Open the graph to explore further.</p>}
            {graph.omitted > 0 && <p>{graph.omitted} more connected records are outside this preview. Open the graph to explore them.</p>}
          </>}
  </section>;
}
