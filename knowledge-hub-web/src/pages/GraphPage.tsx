import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useGraphData } from '../hooks/useGraphData';
import { DataNotice } from '../components/DataNotice';
import { PageHeader } from '../components/PageHeader';
import { AtlasForceMap } from '../components/graph/AtlasForceMap';
import { GraphRelationships } from '../components/graph/GraphRelationships';
import { AtlasAsk } from '../components/graph/AtlasAsk';
import { atlasAdjacency, atlasContextIds, atlasInsights, buildAtlasData } from '../components/graph/atlasData';
import { edgeLabel, graphNodeHref, isInferred } from '../components/graph/atlasModel';
import type { GraphEdge, GraphNode } from '../services/api';
import { SidePanelClose, SidePanelOpen } from '@carbon/icons-react';
import { usePersistedBoolean } from '../hooks/usePersistedState';
import { slidePanels } from '../utils/panelTransition';
import '../components/graph/atlas.scss';

const EMPTY_NODES: GraphNode[] = [], EMPTY_EDGES: GraphEdge[] = [];
export const GraphPage: React.FC = () => {
  const [params, setParams] = useSearchParams(), seed = params.get('seed');
  const [mode, setMode] = useState<'map' | 'list'>('map');
  const [days, setDays] = useState(3650), [depth, setDepth] = useState(2);
  const [query, setQuery] = useState(''), [hidden, setHidden] = useState<string[]>([]);
  const [range, setRange] = useState(9999), [group, setGroup] = useState('');
  const [retainContext, setRetainContext] = useState(true), [inferred, setInferred] = useState(false);
  const [selected, setSelected] = useState<string | null>(seed), [path, setPath] = useState<string[]>([]);
  const [edgeId, setEdgeId] = useState<string | null>(null);
  const [history, setHistory] = useState<Array<string | null>>([]);
  const [resetVersion, setResetVersion] = useState(0), [layoutVersion, setLayoutVersion] = useState(0);
  const [inspectorOpen, setInspectorOpenNow] = usePersistedBoolean('kh_atlas_inspector_open', false);
  // The graph is the hero: the inspector slides in on demand, then the map refits to the new width.
  const setInspectorOpen = useCallback((next: boolean): void => {
    slidePanels(() => { setInspectorOpenNow(next); });
    window.setTimeout(() => { setLayoutVersion(v => v + 1); }, 280);
  }, [setInspectorOpenNow]);
  const { data, isLoading, isError, error, retry } = useGraphData({ days, seed, depth, includeInferred: inferred });
  const nodes = data?.nodes ?? EMPTY_NODES, edges = data?.edges ?? EMPTY_EDGES;
  const allowedEdges = useMemo(() => edges.filter(e => inferred || !isInferred(e)), [edges, inferred]);
  const atlas = useMemo(() => buildAtlasData(nodes, allowedEdges), [nodes, allowedEdges]);
  const adjacency = useMemo(() => atlasAdjacency(atlas), [atlas]);
  const insights = useMemo(() => atlasInsights(atlas), [atlas]);
  const context = useMemo(() => atlasContextIds(atlas, hidden, retainContext), [atlas, hidden, retainContext]);
  const visibleIds = useMemo(() => new Set(atlas.nodes.filter(n => n.hub || !hidden.includes(n.type) || context.has(n.id)).map(n => n.id)), [atlas, hidden, context]);
  const visibleNodes = nodes.filter(n => visibleIds.has(n.id));
  const visibleEdges = allowedEdges.filter(e => visibleIds.has(e.source) && visibleIds.has(e.target));
  const by = new Map(nodes.map(n => [n.id, n])), items = new Map(atlas.nodes.map(n => [n.id, n]));
  const node = selected ? by.get(selected) : undefined, item = selected ? items.get(selected) : undefined;
  const connections = selected ? adjacency.get(selected) ?? [] : [];
  const edge = edges.find(e => e.id === edgeId);
  const types = Object.entries(atlas.types).sort(([a], [b]) => Number(b === 'project') - Number(a === 'project') || a.localeCompare(b));
  const matches = query.trim() ? nodes.filter(n => n.title.toLowerCase().includes(query.trim().toLowerCase())) : [];
  const onPath = useCallback((next: string[]) => {
    setPath(next);
    if (next.length) { setHidden([]); setQuery(''); setRange(9999); setGroup(''); setSelected(null); setEdgeId(null); }
  }, []);
  useEffect(() => {
    setSelected(data?.rootId ?? seed); setPath([]); setEdgeId(null);
  }, [seed, data]);
  const wantsInspector = !!selected || !!edgeId || path.length > 0;
  useEffect(() => { if (wantsInspector) setInspectorOpenNow(true); }, [wantsInspector, setInspectorOpenNow]);
  function reset(): void {
    setSelected(null); setPath([]); setEdgeId(null); setHidden([]); setQuery(''); setRange(9999); setGroup('');
    setResetVersion(v => v + 1);
  }
  function start(id: string | null): void {
    setHistory(previous => [...previous, seed]); setParams(id ? { seed: id } : {}); reset();
  }
  function select(n: GraphNode | null): void {
    setSelected(n?.id ?? null); setEdgeId(null);
    if (n && hidden.includes(items.get(n.id)?.type ?? '')) setHidden([]);
  }
  function toggle(type: string): void { setHidden(current => current.includes(type) ? current.filter(t => t !== type) : [...current, type]); setPath([]); }
  return <main className="atlas atlas--handoff" aria-label="Knowledge atlas">
    <PageHeader title="Knowledge atlas" subtitle="Projects, people and the ideas between them" actions={
      <div className="atlas__summary">
        <span title={`${data?.stats.truncated ? 'Partial graph: explore a record to load its neighbourhood.' : 'Loaded graph; not exhaustive coverage.'} Activity uses latest saved updates, not a historical event log.`}>
          {visibleNodes.length === nodes.length ? nodes.length : `${visibleNodes.length} of ${nodes.length}`} entities · {visibleEdges.length} connections · {atlas.nodes.filter(n => n.hub).length} projects{data?.stats.truncated ? ' · partial graph' : ''}</span>
        {!!history.length && <button className="kh-btn-ghost" onClick={() => {
          setParams(history.at(-1) ? { seed: history.at(-1)! } : {}); setHistory(h => h.slice(0, -1)); reset();
        }}>Back</button>}
        {seed && <button className="kh-btn-ghost" onClick={() => { start(null); }}>Whole atlas</button>}
        <nav className="atlas__modes" aria-label="Graph view">{(['map', 'list'] as const).map(value => <button key={value}
          aria-pressed={mode === value} onClick={() => { setMode(value); }}>{value === 'map' ? 'Graph' : 'Relationships'}</button>)}</nav>
        <button className="atlas__panel-toggle" aria-expanded={inspectorOpen} aria-controls="atlas-inspector"
          title={inspectorOpen ? 'Hide the Athena panel' : 'Ask Athena and see details'} onClick={() => { setInspectorOpen(!inspectorOpen); }}>
          {inspectorOpen ? <SidePanelClose size={16} /> : <SidePanelOpen size={16} />}<span>Athena</span></button>
      </div>
    } />
    <div className="atlas__toolbar">
      <div className="atlas__search"><label className="atlas__sr" htmlFor="atlas-search">Find in loaded graph</label>
        <input id="atlas-search" placeholder="Find a project, person or idea..." value={query} onChange={e => { setQuery(e.target.value); }} />
        {query.trim() && <div className="atlas__results" aria-label="Search results">
          <p>{matches.length ? `${matches.length} loaded matches` : 'No matches in this loaded subset.'}</p>
          {matches.slice(0, 12).map(n => <button key={n.id} onClick={() => { select(n); setQuery(''); }}>
            <strong>{n.title}</strong><span>{n.refType}</span></button>)}
        </div>}
      </div>
      <div className="atlas__types" role="group" aria-label="Entity types">
        {types.map(([type, meta]) => <button key={type} className={`atlas__type${hidden.includes(type) ? ' atlas__type--off' : ''}`}
          aria-pressed={!hidden.includes(type)} disabled={type === 'project'} title={type === 'project' ? 'Project anchors stay visible' : `Toggle ${meta.label.toLowerCase()}`}
          onClick={() => { toggle(type); }}><span className="atlas__dot" style={{ backgroundColor: meta.color }} />
          {meta.label}<span>{atlas.nodes.filter(n => n.type === type).length}</span></button>)}
      </div>
      <div className="atlas__range" role="group" aria-label="Active in"><span>Active in</span>
        {[7, 30, 90, 9999].map(value => <button key={value} aria-pressed={range === value} onClick={() => { setRange(value); }}>
          {value === 9999 ? 'All time' : `${value} days`}</button>)}</div>
      <details className="atlas__options"><summary>Options</summary><div>
        <label>Focus type<select value={types.filter(([t]) => t !== 'project' && !hidden.includes(t)).length === 1
          ? types.find(([t]) => t !== 'project' && !hidden.includes(t))?.[0] ?? '' : ''}
          onChange={e => { setHidden(e.target.value ? types.map(([t]) => t).filter(t => t !== 'project' && t !== e.target.value) : []); setPath([]); }}>
          <option value="">All types</option>{types.filter(([t]) => t !== 'project').map(([t, meta]) => <option key={t} value={t}>{meta.label}</option>)}
        </select></label>
        <label><input type="checkbox" checked={retainContext} onChange={e => { setRetainContext(e.target.checked); }} /> Keep connected records as context</label>
        <label><input type="checkbox" checked={inferred} onChange={e => { setInferred(e.target.checked); setPath([]); }} /> Include inferred links</label>
        <label>Load records updated within<select value={days} onChange={e => { setDays(Number(e.target.value)); }}>
          <option value={30}>Last 30 days</option><option value={365}>Last year</option><option value={3650}>Last 10 years</option>
        </select></label>
        {seed && <label>Neighbourhood<select value={depth} onChange={e => { setDepth(Number(e.target.value)); }}>
          <option value={1}>One connection</option><option value={2}>Two connections</option></select></label>}
        <p>{data?.stats.truncated ? 'Partial graph: explore a record to load its neighbourhood.' : 'Loaded graph; not exhaustive coverage.'} Activity uses latest saved updates, not a historical event log.</p>
        <p>Activity dims older records; it does not erase their connections. Type focus retains direct neighbours by default.</p>
      </div></details>
    </div>
    {isError && <DataNotice title="Graph data is unavailable" error={error} onRetry={() => { void retry(); }} />}
    <div className="atlas__workspace">
      <section className="atlas__stage" aria-label="Graph display">
        {isError ? null : isLoading ? <p className="atlas__empty" role="status">Loading your connections...</p>
          : nodes.length === 0 ? <div className="atlas__empty"><h2>No records in this view</h2><p>Try the whole atlas or a wider load period.</p>
            <button onClick={() => { setDays(3650); start(null); }}>Widen view</button></div>
            : mode === 'list' ? <GraphRelationships nodes={visibleNodes} edges={visibleEdges} query={query} truncated={data?.stats.truncated ?? false} onSelect={select} />
              : <AtlasForceMap nodes={nodes} edges={allowedEdges} data={atlas} selected={selected} onSelect={select}
                path={path} hiddenTypes={hidden} contextIds={[...context]} search={query} range={range} group={group}
                scope={seed ?? ''} depth={depth} fitVersion={resetVersion + layoutVersion} />}
        {mode === 'map' && !!nodes.length && <>
          {(selected || path.length > 0 || hidden.length > 0 || query || group || range !== 9999) && <button className="atlas__show-all" onClick={reset}>Show everything</button>}
          <div className="atlas__legend" aria-label="Graph legend">{types.map(([type, meta]) => <span key={type}>
            <i className="atlas__dot" style={{ backgroundColor: meta.color }} />{meta.one}</span>)}
            <span>Dashed: cross-project / inferred links</span></div>
        </>}
      </section>
      <aside id="atlas-inspector" className="atlas__inspector" aria-label="Selected connection details" hidden={!inspectorOpen}>
        {node && item && <section className="atlas__selected">
          <button className="atlas__close" aria-label="Close details" onClick={() => { select(null); }}>×</button>
          <span className="atlas__kind"><i className="atlas__dot" style={{ backgroundColor: atlas.types[item.type]!.color }} />{atlas.types[item.type]!.one}</span>
          <h2>{node.title}</h2><p className={item.last > 14 ? 'atlas__quiet' : ''}>
            {item.project ? `${items.get(item.project)?.name ?? 'Project'} · ` : 'No loaded project assignment · '}
            {item.last > 14 ? `quiet ${item.last} days` : `active ${item.last} days ago`} · {connections.length} loaded connections
          </p>
          <div className="atlas__actions"><Link to={graphNodeHref(node)}>Open record</Link>
            <button onClick={() => { start(node.id); }}>Explore from here</button></div>
          <h3>Recorded connections</h3>
          {connections.length ? <ul className="atlas__connections">{connections.map(link => <li key={link.edge.id}>
            <button onClick={() => { select(by.get(link.id) ?? null); }}>{by.get(link.id)?.title ?? 'Unavailable record'}</button>
            <button className="atlas__relationship" onClick={() => { setEdgeId(link.edge.id); }}>
              {link.edge.rel}{link.edge.inferred ? ' · inferred, not confirmed' : ''}</button>
          </li>)}</ul> : <p>No connections in the loaded subset. Explore from here to check this record’s neighbourhood.</p>}
        </section>}
        {edge && <section className="atlas__edge-detail"><h3>{edgeLabel(edge)}</h3>
          <p>{by.get(edge.source)?.title} → {by.get(edge.target)?.title}</p>
          <p>{isInferred(edge) ? 'Inferred relationship — not a confirmed fact' : edge.origin === 'user_confirmed' ? 'User-confirmed relationship' : 'Recorded relationship'}</p>
          {['evidence', 'role', 'note', 'reason', 'projectId'].map(key => typeof edge.metadata?.[key] === 'string'
            ? <p key={key}>{key}: {String(edge.metadata[key])}</p> : null)}
        </section>}
        <AtlasAsk key={resetVersion} data={atlas} selected={selected} path={path} onPath={onPath} onSelect={id => { select(by.get(id) ?? null); }} />
        {!path.length && <section className="atlas__insights"><h2>Athena noticed</h2>
          {insights.length ? insights.map(insight => <article key={insight.id}><h3>{insight.title}</h3><p>{insight.text}</p>
            <button className="atlas__athena-action" onClick={() => {
              if (insight.path) onPath(insight.path);
              else if (insight.node) { reset(); setSelected(insight.node); }
              else if (insight.islands) { reset(); setGroup('islands'); }
            }}>{insight.action}</button></article>) : <p>No additional patterns in the loaded graph.</p>}
        </section>}
      </aside>
    </div>
  </main>;
};
