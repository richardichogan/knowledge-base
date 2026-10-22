import React, { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useGraphData } from '../hooks/useGraphData';
import { deferredView } from '../utils/deferredView';
import { DataNotice } from '../components/DataNotice';
import { AtlasForceMap } from '../components/graph/AtlasForceMap';
import { GraphRelationships } from '../components/graph/GraphRelationships';
import { activityTime, activityWindow, atlasLayout, DAY_MS, edgeLabel, graphNodeHref, isInferred, type AtlasMode } from '../components/graph/atlasModel';
import { AtlasTimeline } from '../components/graph/AtlasTimeline';
import type { GraphEdge, GraphNode } from '../services/api';
import '../components/graph/atlas.scss';

const Space = deferredView('3D knowledge atlas', async () => ({ default: (await import('../components/graph/AtlasSpace')).AtlasSpace }));
const EMPTY_NODES: GraphNode[] = [], EMPTY_EDGES: GraphEdge[] = [];

function supports3D(): boolean {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2');
  if (!gl) return false;
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return true;
}

export const GraphPage: React.FC = () => {
  const [params, setParams] = useSearchParams();
  const seed = params.get('seed');
  const [mode, setMode] = useState<AtlasMode>('map');
  const [days, setDays] = useState(365);
  const [depth, setDepth] = useState(1);
  const [query, setQuery] = useState('');
  const [type, setType] = useState('');
  const [project, setProject] = useState('');
  const [connectionsOnly, setConnectionsOnly] = useState(false);
  const [includeUnconnected, setIncludeUnconnected] = useState(false);
  const [inferred, setInferred] = useState(false);
  const [colourMode, setColourMode] = useState<'type' | 'concept'>('type');
  const [selected, setSelected] = useState<string | null>(seed);
  const [edgeId, setEdgeId] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(seed);
  const [history, setHistory] = useState<Array<string | null>>([]);
  const [timeEnabled, setTimeEnabled] = useState(false);
  const [endDay, setEndDay] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [webgl] = useState(supports3D);
  const [now] = useState(() => Date.now());
  const [reducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const { data, isLoading, isError, error, retry } = useGraphData({ days, seed, depth });
  const nodes = data?.nodes ?? EMPTY_NODES, edges = data?.edges ?? EMPTY_EDGES;
  const allowedEdges = useMemo(() => edges.filter(e => inferred || !isInferred(e)), [edges, inferred]);
  const types = useMemo(() => [...new Set(nodes.map(n => n.refType))].sort(), [nodes]);
  const projects = useMemo(() => nodes.filter(n => n.refType === 'project').sort((a, b) => a.title.localeCompare(b.title)), [nodes]);
  const from = now - (endDay + 7) * DAY_MS, to = now - endDay * DAY_MS;
  const activity = useMemo(() => activityWindow(nodes, allowedEdges, from, to), [nodes, allowedEdges, from, to]);
  const previous = useMemo(() => activityWindow(nodes, allowedEdges, from - 7 * DAY_MS, from - 1), [nodes, allowedEdges, from]);
  const selectionIds = useMemo(() => {
    const result = new Set(selected ? [selected] : []);
    for (const e of allowedEdges) {
      if (e.source === selected) result.add(e.target);
      if (e.target === selected) result.add(e.source);
    }
    return result;
  }, [selected, allowedEdges]);
  const selectionFilter = connectionsOnly ? selectionIds : null;
  const filteredNodes = useMemo(() => nodes.filter(n => (!type || n.refType === type)
    && (!project || n.projectIds?.includes(project)) && (!timeEnabled || activity.context.has(n.id))
    && (!selectionFilter || selectionFilter.has(n.id))), [nodes, type, project, timeEnabled, activity, selectionFilter]);
  const connectedIds = useMemo(() => new Set(allowedEdges.flatMap(e => [e.source, e.target])), [allowedEdges]);
  const unconnectedSelection = selected && !connectedIds.has(selected) ? selected : null;
  const visibleNodes = useMemo(() => includeUnconnected || mode === 'list' ? filteredNodes
    : filteredNodes.filter(n => connectedIds.has(n.id) || n.id === unconnectedSelection || n.id === data?.rootId),
  [includeUnconnected, mode, filteredNodes, connectedIds, unconnectedSelection, data?.rootId]);
  const visibleEdges = useMemo(() => {
    const ids = new Set(visibleNodes.map(n => n.id));
    return allowedEdges.filter(e => ids.has(e.source) && ids.has(e.target));
  }, [visibleNodes, allowedEdges]);
  const layout = useMemo(() => atlasLayout(visibleNodes), [visibleNodes]);
  const matches = query.trim() ? filteredNodes.filter(n => n.title.toLowerCase().includes(query.trim().toLowerCase())) : [];
  const node = nodes.find(n => n.id === selected);
  const edge = edges.find(e => e.id === edgeId);
  const connected = node ? visibleEdges.filter(e => e.source === node.id || e.target === node.id) : [];
  const byId = new Map(nodes.map(n => [n.id, n]));

  useEffect(() => {
    setSelected(data?.rootId ?? seed); setFocus(data?.rootId ?? seed); setEdgeId(null); setConnectionsOnly(false);
  }, [seed, data?.rootId]);
  useEffect(() => {
    if (!playing || !timeEnabled || reducedMotion) return;
    const timer = window.setInterval(() => {
      setEndDay(day => { if (day <= 1) { setPlaying(false); return 0; } return day - 1; });
    }, 1000);
    return () => { window.clearInterval(timer); };
  }, [playing, timeEnabled, reducedMotion]);
  function start(id: string | null): void {
    setHistory(h => [...h, seed]); setParams(id ? { seed: id } : {});
    setProject(''); setType(''); setQuery(''); setTimeEnabled(false); setPlaying(false);
    setConnectionsOnly(false);
  }
  function select(n: GraphNode): void { setSelected(n.id); setFocus(n.id); setEdgeId(null); }
  function inspect(e: GraphEdge): void { setEdgeId(e.id); setSelected(null); setFocus(null); setConnectionsOnly(false); }

  return <main className="atlas" aria-label="Knowledge atlas">
    <header className="atlas__header">
      <div><h1>Knowledge atlas</h1><p>{seed ? 'Explore a neighbourhood' : 'Projects, people and the ideas between them'}</p></div>
      <nav className="atlas__modes" aria-label="Graph view">
        {(['map', 'space', 'list'] as const).map(value => <button key={value} aria-pressed={mode === value}
          disabled={value === 'space' && !webgl} title={value === 'space' && !webgl ? 'WebGL2 is unavailable; use Map or Relationships' : undefined}
          onClick={() => { setMode(value); }}>{value === 'map' ? '2D graph' : value === 'space' ? '3D explorer' : 'Relationships'}</button>)}
      </nav>
    </header>
    <div className="atlas__toolbar">
      <div className="atlas__search">
        <label className="atlas__sr" htmlFor="atlas-search">Find in loaded graph</label>
        <input id="atlas-search" placeholder="Find a project, person or idea…" value={query} onChange={e => { setQuery(e.target.value); }} />
        {query.trim() && <div className="atlas__results" aria-label="Search results">
          <p>{matches.length ? `${matches.length} matches in loaded graph` : 'No matches in the loaded graph. Try a wider scope.'}</p>
          {matches.slice(0, 12).map(n => <button key={n.id} onClick={() => { select(n); setFocus(n.id); setQuery(''); }}>
            <strong>{n.title}</strong><span>{n.refType}</span>
          </button>)}
          {matches.length > 12 && <p>Showing the first 12. Refine your search.</p>}
        </div>}
      </div>
      <label>Project<select value={project} onChange={e => { setProject(e.target.value); }}>
        <option value="">All loaded</option>{projects.map(p => <option key={p.id} value={p.refId}>{p.title}</option>)}
      </select></label>
      <label>Show<select value={type} onChange={e => { setType(e.target.value); }}><option value="">All types</option>
        {types.map(t => <option key={t}>{t}</option>)}</select></label>
      <button aria-pressed={timeEnabled} onClick={() => { setTimeEnabled(v => !v); setPlaying(false); }}>Activity</button>
      <details className="atlas__options"><summary>Options</summary><div>
        <label>Load activity<select value={days} onChange={e => { setDays(Number(e.target.value)); }}>
          <option value={30}>Last 30 days</option><option value={365}>Last year</option><option value={3650}>Last 10 years</option>
        </select></label>
        {seed && <label>Neighbourhood<select value={depth} onChange={e => { setDepth(Number(e.target.value)); }}>
          <option value={1}>One connection</option><option value={2}>Two connections</option></select></label>}
        <label>Colour<select value={colourMode} onChange={e => { setColourMode(e.target.value === 'concept' ? 'concept' : 'type'); }}>
          <option value="type">Entity type</option><option value="concept">Concept area</option></select></label>
        <label><input type="checkbox" checked={inferred} onChange={e => { setInferred(e.target.checked); }} /> Include inferred links</label>
        <label><input type="checkbox" checked={includeUnconnected} onChange={e => { setIncludeUnconnected(e.target.checked); }} /> Include unconnected records</label>
        <p>Inferred links are dashed in Map. Positions organise the view; distance and 3D depth do not prove a relationship.</p>
      </div></details>
    </div>
    <div className="atlas__scope">
      <button disabled={!history.length} onClick={() => {
        const last = history.at(-1) ?? null; setHistory(h => h.slice(0, -1)); setParams(last ? { seed: last } : {});
        setProject(''); setType(''); setTimeEnabled(false); setPlaying(false);
        setConnectionsOnly(false);
      }}>Back</button>
      {seed && <button onClick={() => { start(null); }}>Whole atlas</button>}
      {connectionsOnly && <button onClick={() => { setConnectionsOnly(false); }}>Show all loaded connections</button>}
      <span>{visibleNodes.length} entities · {visibleEdges.length} connections{data?.stats.truncated ? ' · Partial graph: narrow your focus to see more' : ' · Loaded graph, not exhaustive coverage'}</span>
      {visibleNodes.length < filteredNodes.length && <button onClick={() => { setIncludeUnconnected(true); }}>Show {filteredNodes.length - visibleNodes.length} unconnected</button>}
    </div>
    {isError && <DataNotice title="Graph data is unavailable" error={error} onRetry={() => { void retry(); }} />}
    <div className="atlas__workspace">
      <section className="atlas__stage" aria-label="Graph display">
        {isError ? null : isLoading ? <p className="atlas__empty" role="status">Loading your connections…</p>
          : visibleNodes.length === 0 ? <div className="atlas__empty"><h2>No connections in this view</h2>
            <p>{seed ? 'This record may be unavailable or have no visible relationships.' : 'Try widening the period or clearing your filters.'}</p>
            <button onClick={() => { setType(''); setProject(''); setTimeEnabled(false); setDays(3650); setIncludeUnconnected(true); }}>Widen view</button></div>
            : mode === 'list' ? <GraphRelationships nodes={visibleNodes} edges={visibleEdges} query={query} truncated={data?.stats.truncated ?? false} onSelect={select} />
              : mode === 'space' ? <Space nodes={visibleNodes} edges={visibleEdges} layout={layout} selected={selected} focus={focus} onSelect={select} onEdge={inspect} colourMode={colourMode} />
                : <AtlasForceMap nodes={visibleNodes} edges={visibleEdges} layout={layout} selected={selected} onSelect={select} onEdge={inspect}
                  focus={focus} active={timeEnabled ? activity.active : null} colourMode={colourMode} />}
      </section>
      {(node || edge) && <aside className="atlas__inspector" aria-label="Selected connection details">
        <button className="atlas__close" aria-label="Close details" onClick={() => { setSelected(null); setFocus(null); setEdgeId(null); setConnectionsOnly(false); }}>×</button>
        {node && <>
          <span className="atlas__kind">{node.refType}</span><h2>{node.title}</h2>
          <p>{node.timestampBasis === 'index' ? 'Graph index last changed' : 'Record last changed'}: {new Date(activityTime(node)).toLocaleDateString('en-GB')}</p>
          <div className="atlas__actions"><Link to={graphNodeHref(node)}>Open in hub</Link><button onClick={() => { start(node.id); }}>Explore from here</button></div>
          <button aria-pressed={connectionsOnly} onClick={() => { setConnectionsOnly(v => !v); }}>
            {connectionsOnly ? 'Show all loaded connections' : 'Isolate this record and its connections'}
          </button>
          <h3>Connections in this view</h3>
          {connected.length ? <ul className="atlas__connections">{connected.map(e => {
            const other = byId.get(e.source === node.id ? e.target : e.source);
            return <li key={e.id}><button onClick={() => { if (other) select(other); }}>{other?.title ?? 'Unavailable record'}</button>
              <button className="atlas__relationship" onClick={() => { inspect(e); }}>{edgeLabel(e)}{isInferred(e) ? ' · inferred' : ''} →</button></li>;
          })}</ul> : <p>No visible connections. Try including inferred links or widening the scope.</p>}
        </>}
        {edge && <>
          <h2>{edgeLabel(edge)}</h2>
          <p>{byId.get(edge.source)?.title} → {byId.get(edge.target)?.title}</p>
          <strong>{isInferred(edge) ? 'Inferred relationship — not a confirmed fact' : edge.origin === 'user_confirmed' ? 'User-confirmed relationship' : 'Recorded relationship'}</strong>
          <p>{typeof edge.metadata?.['evidence'] === 'string' ? edge.metadata['evidence'] : 'Stored graph connection'}</p>
          {['role', 'note', 'reason', 'rationale', 'projectId'].map(key => {
            const value = edge.metadata?.[key];
            return typeof value === 'string' && value ? <p key={key}>{key}: {value}</p> : null;
          })}
          {edge.createdAt ? <p>Recorded {new Date(edge.createdAt).toLocaleDateString('en-GB')}</p>
            : <p>The date this relationship began is not recorded.</p>}
          <div className="atlas__actions">{[edge.source, edge.target].map(id => {
            const target = byId.get(id);
            return target ? <Link key={id} to={graphNodeHref(target)}>Open {target.refType}</Link> : null;
          })}</div>
        </>}
      </aside>}
    </div>
    {timeEnabled && <AtlasTimeline nodes={nodes} now={now} endDay={endDay} onChange={day => { setEndDay(day); setPlaying(false); }}
      playing={playing} reducedMotion={reducedMotion} onPlay={() => { if (endDay === 0) setEndDay(28); setPlaying(v => !v); }}
      currentCount={activity.active.size} previousCount={previous.active.size} />}
  </main>;
};
