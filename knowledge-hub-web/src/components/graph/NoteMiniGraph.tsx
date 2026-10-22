import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useGraphData } from '../../hooks/useGraphData';
import { DataNotice } from '../DataNotice';
import { AtlasMap } from './AtlasMap';
import { graphNodeHref, isInferred, neighbourhood, type AtlasLayout } from './atlasModel';
import './atlas.scss';

export function NoteMiniGraph({ noteId }: { noteId: string }): React.ReactElement {
  const seed = `note:${noteId}`;
  const { data, isLoading, isError, error, retry } = useGraphData({ days: 3650, seed, depth: 1 });
  const [selected, setSelected] = useState<string | null>(null);
  const graph = useMemo(() => neighbourhood(data?.nodes ?? [], (data?.edges ?? []).filter(e => !isInferred(e)), seed, 9), [data, seed]);
  const layout = useMemo((): AtlasLayout => {
    const positions = new Map<string, { x: number; y: number; z: number }>();
    positions.set(seed, { x: 180, y: 150, z: 0 });
    const others = graph.nodes.filter(n => n.id !== seed);
    others.forEach((node, i) => {
      const angle = 2 * Math.PI * i / Math.max(1, others.length) - Math.PI / 2;
      positions.set(node.id, { x: 180 + Math.cos(angle) * 128, y: 150 + Math.sin(angle) * 103, z: 0 });
    });
    return { positions, clusters: [], width: 360, height: 300 };
  }, [graph, seed]);
  const chosen = graph.nodes.find(n => n.id === selected);
  return <section className="note-mini-graph" aria-label="Note knowledge graph">
    <div className="note-mini-graph__heading"><h2>Around this note</h2>
      <Link to={`/graph?seed=${encodeURIComponent(seed)}`}>Explore graph →</Link></div>
    {isLoading ? <p role="status">Loading connections…</p>
      : isError ? <DataNotice title="Note graph is unavailable" error={error} onRetry={() => { void retry(); }} />
        : graph.nodes.length <= 1 ? <p>No visible connections yet. Link a project or mention another record to start a neighbourhood.</p>
          : <>
            <AtlasMap compact nodes={graph.nodes} edges={graph.edges} layout={layout} selected={chosen?.id ?? seed}
              onSelect={node => { setSelected(node.id); }} />
            {chosen && <div className="note-mini-graph__selection"><strong>{chosen.title}</strong><span>{chosen.refType}</span>
              <Link to={graphNodeHref(chosen)}>Open in hub</Link>
              <Link to={`/graph?seed=${encodeURIComponent(chosen.id)}`}>Explore from here</Link></div>}
            <details><summary>Browse connected records</summary>
              <ul>{graph.nodes.filter(n => n.id !== seed).map(n => <li key={n.id}><Link to={graphNodeHref(n)}>{n.title}</Link> <span>{n.refType}</span></li>)}</ul>
            </details>
            {(graph.omitted > 0 || data?.stats.truncated) && <p>Preview limited to eight neighbours. Open the graph for a wider view.</p>}
          </>}
  </section>;
}
