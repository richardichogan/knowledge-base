import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FitToScreen, Renew, ZoomIn, ZoomOut } from '@carbon/icons-react';
import ForceGraph2D, { type ForceGraphMethods, type LinkObject, type NodeObject } from 'react-force-graph-2d';
import type { GraphEdge, GraphNode } from '../../services/api';
import { useIdentity } from '../../identity';
import { nodeColour } from './graphColour';
import { forceGraphData, isInferred, placeAtlasLabels } from './atlasModel';
import type { AtlasMapProps } from './AtlasMap';

type ForceNode = NodeObject<GraphNode>;
type ForceLink = LinkObject<GraphNode, Omit<GraphEdge, 'source' | 'target'>>;
const endpoint = (value: ForceLink['source']): string => typeof value === 'object' ? value.id : String(value);
const motionPhase = (value: string): number => {
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return (Math.abs(hash) % 1000) / 1000;
};

export function AtlasForceMap({ nodes, edges, selected, focus, onSelect, onEdge, active, compact = false,
  colourMode = 'type' }: Omit<AtlasMapProps, 'layout'>): React.ReactElement {
  const container = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraphMethods<GraphNode, Omit<GraphEdge, 'source' | 'target'>>>();
  const needsFit = useRef(true);
  const layoutSettled = useRef(false);
  const dragging = useRef(false);
  const animationStartedAt = useRef(performance.now());
  const driftAnchors = useRef(new WeakMap<ForceNode, { x: number; y: number; phase: number }>());
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [hovered, setHovered] = useState<string | null>(null);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [inViewport, setInViewport] = useState(true);
  const [pageVisible, setPageVisible] = useState(() => !document.hidden);
  const identity = useIdentity();
  const graph = useMemo<{ nodes: ForceNode[]; links: ForceLink[] }>(() => forceGraphData(nodes, edges), [nodes, edges]);
  const nodeOrder = useMemo(() => new Map(graph.nodes.map((node, index) => [node.id, index])), [graph]);
  const adjacency = useMemo(() => {
    const result = new Map<string, Set<string>>();
    for (const edge of edges) {
      if (!result.has(edge.source)) result.set(edge.source, new Set());
      if (!result.has(edge.target)) result.set(edge.target, new Set());
      result.get(edge.source)!.add(edge.target); result.get(edge.target)!.add(edge.source);
    }
    return result;
  }, [edges]);
  const spotlight = hovered ?? selected;
  const neighbours = spotlight ? adjacency.get(spotlight) : undefined;
  const duration = reducedMotion ? 0 : 220;
  const animate = !reducedMotion && inViewport && pageVisible;
  const fit = useCallback(() => {
    const renderer = graphRef.current;
    if (!renderer) return;
    if (!compact) { renderer.zoomToFit(duration, 65); return; }
    // A few far-flung leaves would otherwise shrink the small panel's view to a dot cluster.
    const placed = graph.nodes.filter(n => n.x !== undefined && n.y !== undefined);
    const cx = placed.reduce((s, n) => s + n.x!, 0) / Math.max(1, placed.length);
    const cy = placed.reduce((s, n) => s + n.y!, 0) / Math.max(1, placed.length);
    const distances = placed.map(n => Math.hypot(n.x! - cx, n.y! - cy)).sort((a, b) => a - b);
    const cutoff = distances[Math.floor((distances.length - 1) * 0.9)] ?? Infinity;
    renderer.zoomToFit(duration, 24, n => n.id === focus || n.id === selected
      || (n.x !== undefined && n.y !== undefined && Math.hypot(n.x - cx, n.y - cy) <= cutoff));
  }, [duration, compact, graph, focus, selected]);

  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: Math.max(1, entry.contentRect.width), height: Math.max(1, entry.contentRect.height) });
    });
    observer.observe(el); return () => { observer.disconnect(); };
  }, []);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = (): void => { setReducedMotion(media.matches); };
    media.addEventListener('change', update);
    return () => { media.removeEventListener('change', update); };
  }, []);
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => { setInViewport(entry?.isIntersecting ?? false); });
    observer.observe(el);
    const updateVisibility = (): void => { setPageVisible(!document.hidden); };
    document.addEventListener('visibilitychange', updateVisibility);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', updateVisibility);
    };
  }, []);
  useEffect(() => {
    needsFit.current = true;
    layoutSettled.current = false;
    animationStartedAt.current = performance.now();
    driftAnchors.current = new WeakMap();
    const renderer = graphRef.current;
    renderer?.d3Force('charge')?.strength(-100);
    renderer?.d3Force('link')?.distance(65).strength(0.3);
    for (const node of graph.nodes) { delete node.fx; delete node.fy; }
  }, [graph]);
  useEffect(() => {
    layoutSettled.current = false;
    driftAnchors.current = new WeakMap();
    for (const node of graph.nodes) { delete node.fx; delete node.fy; }
    const renderer = graphRef.current;
    renderer?.d3Force('link')?.distance((link: ForceLink) => endpoint(link.source) === selected || endpoint(link.target) === selected ? 48 : 65).strength(0.3);
    renderer?.d3ReheatSimulation();
  }, [graph, selected]);
  useEffect(() => {
    if (!animate) return;
    let frame = 0;
    const drift = compact ? 0.35 : 0.9;
    const move = (now: number): void => {
      if (layoutSettled.current && !dragging.current) {
        for (const node of graph.nodes) {
          if (node.x === undefined || node.y === undefined) continue;
          let anchor = driftAnchors.current.get(node);
          if (!anchor) {
            anchor = { x: node.x, y: node.y, phase: motionPhase(node.id) * Math.PI * 2 };
            driftAnchors.current.set(node, anchor);
          }
          const amplitude = node.refType === 'project' ? drift * 0.35 : drift;
          node.x = anchor.x + Math.sin(now * 0.0005 + anchor.phase) * amplitude;
          node.y = anchor.y + Math.cos(now * 0.00043 + anchor.phase * 1.7) * amplitude;
          node.fx = node.x;
          node.fy = node.y;
        }
      }
      frame = requestAnimationFrame(move);
    };
    frame = requestAnimationFrame(move);
    return () => { cancelAnimationFrame(frame); };
  }, [animate, compact, graph]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const node = focus ? graph.nodes.find(n => n.id === focus) : undefined;
      if (node?.x !== undefined && node.y !== undefined) {
        needsFit.current = false;
        graphRef.current?.centerAt(node.x, node.y, duration);
        graphRef.current?.zoom(Math.max(1.1, graphRef.current.zoom()), duration);
      } else fit();
    });
    return () => { cancelAnimationFrame(frame); };
  }, [focus, graph, size, duration, fit]);

  function drawNode(node: ForceNode, ctx: CanvasRenderingContext2D, scale: number): void {
    if (node.x === undefined || node.y === undefined) return;
    const highlighted = node.id === spotlight || neighbours?.has(node.id);
    const radius = (node.id === selected ? 4.5 : 3) / Math.sqrt(scale);
    const now = performance.now();
    const order = nodeOrder.get(node.id) ?? 0;
    const delay = graph.nodes.length > 1 ? (order / (graph.nodes.length - 1)) * 450 : 0;
    const progress = reducedMotion ? 1 : Math.max(0, Math.min(1, (now - animationStartedAt.current - delay) / 450));
    const grow = 1 - Math.pow(1 - progress, 3);
    ctx.globalAlpha = (spotlight && !highlighted ? 0.18 : 1) * grow;
    ctx.fillStyle = node.id === spotlight ? '#f4f4f4'
      : nodeColour(node.refType, node.conceptParent, colourMode, name => identity.byName(name)?.hex);
    ctx.beginPath(); ctx.arc(node.x, node.y, radius * grow, 0, 2 * Math.PI); ctx.fill();
    if (node.id === selected || active?.has(node.id)) {
      ctx.strokeStyle = active?.has(node.id) ? '#f1c21b' : '#3ddbd9'; ctx.lineWidth = 1 / scale;
      ctx.beginPath(); ctx.arc(node.x, node.y, radius * grow + 3 / scale, 0, 2 * Math.PI); ctx.stroke();
    }
    const lastActive = Date.parse(node.updatedAt ?? node.createdAt);
    if (animate && Number.isFinite(lastActive) && Date.now() - lastActive <= 3 * 24 * 60 * 60 * 1000) {
      const pulse = (now % 2400) / 2400;
      ctx.globalAlpha = (1 - pulse) * 0.7;
      ctx.strokeStyle = '#4589ff';
      ctx.lineWidth = 1 / scale;
      ctx.beginPath();
      ctx.arc(node.x, node.y, radius + (4 + pulse * 9) / scale, 0, 2 * Math.PI);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  function drawLinkFlow(link: ForceLink, ctx: CanvasRenderingContext2D, scale: number): void {
    if (!animate) return;
    const source = typeof link.source === 'object' ? link.source : graph.nodes.find(node => node.id === endpoint(link.source));
    const target = typeof link.target === 'object' ? link.target : graph.nodes.find(node => node.id === endpoint(link.target));
    if (!source || !target || source.x === undefined || source.y === undefined || target.x === undefined || target.y === undefined) return;
    const sourceProjects = source.projectIds ?? [];
    const targetProjects = target.projectIds ?? [];
    const crossProject = sourceProjects.length > 0 && targetProjects.length > 0
      && !sourceProjects.some(projectId => targetProjects.includes(projectId));
    const highlighted = endpoint(link.source) === spotlight || endpoint(link.target) === spotlight;
    if (!crossProject && !highlighted) return;
    const phase = (performance.now() / 5500 + motionPhase(String(link.id ?? `${source.id}:${target.id}`))) % 1;
    const points = highlighted ? [phase, (phase + 0.5) % 1] : [phase];
    ctx.save();
    ctx.fillStyle = highlighted ? '#a6c8ff' : '#c6c6c6';
    for (const progress of points) {
      const x = source.x + (target.x - source.x) * progress;
      const y = source.y + (target.y - source.y) * progress;
      ctx.beginPath();
      ctx.arc(x, y, 2 / Math.max(scale, 0.5), 0, 2 * Math.PI);
      ctx.fill();
    }
    ctx.restore();
  }
  function drawLabels(ctx: CanvasRenderingContext2D, scale: number): void {
    const renderer = graphRef.current;
    if (!renderer || !container.current) return;
    const candidates = [...graph.nodes].filter(n => n.id === spotlight || neighbours?.has(n.id)
      || (scale > 1.5 || (adjacency.get(n.id)?.size ?? 0) >= 6))
      .sort((a, b) => Number(b.id === spotlight) - Number(a.id === spotlight)
        || (adjacency.get(b.id)?.size ?? 0) - (adjacency.get(a.id)?.size ?? 0))
      .flatMap(n => n.x === undefined || n.y === undefined ? [] : [{
        id: n.id, text: n.title, ...renderer.graph2ScreenCoords(n.x, n.y),
      }]);
    const labels = placeAtlasLabels(candidates, size.width, size.height);
    ctx.save(); ctx.font = `${12 / scale}px "IBM Plex Sans", sans-serif`; ctx.textAlign = 'center';
    ctx.textBaseline = 'middle'; ctx.lineWidth = 3 / scale;
    ctx.strokeStyle = getComputedStyle(container.current).backgroundColor;
    for (const label of labels) {
      const p = renderer.screen2GraphCoords(label.x + label.width / 2, label.y + 12);
      const max = Math.floor((label.width - 12) / 7.2);
      const text = label.text.length > max ? `${label.text.slice(0, max - 1)}…` : label.text;
      ctx.globalAlpha = spotlight && label.id !== spotlight && !neighbours?.has(label.id) ? 0.2 : 1;
      ctx.fillStyle = label.id === spotlight ? '#f4f4f4' : '#c6c6c6';
      ctx.strokeText(text, p.x, p.y); ctx.fillText(text, p.x, p.y);
    }
    ctx.restore();
  }
  const highlightedLink = (link: ForceLink): boolean => endpoint(link.source) === spotlight || endpoint(link.target) === spotlight;
  return <div className={`atlas-force${compact ? ' atlas-force--compact' : ''}`} ref={container}
    // Programmatic fits also fire onZoom, so only real gestures cancel the settle-time fit.
    onWheel={() => { needsFit.current = false; }} onPointerDown={() => { needsFit.current = false; }}
    role="region" aria-label={compact ? 'Note connections: interactive 2D knowledge graph' : '2D force-directed knowledge graph'}>
    <ForceGraph2D<GraphNode, Omit<GraphEdge, 'source' | 'target'>> ref={graphRef}
      graphData={graph} width={size.width} height={size.height} backgroundColor="transparent"
      nodeLabel="" nodeCanvasObject={drawNode} onRenderFramePost={drawLabels}
      nodePointerAreaPaint={(node, colour, ctx, scale) => {
        if (node.x === undefined || node.y === undefined) return;
        ctx.fillStyle = colour; ctx.beginPath(); ctx.arc(node.x, node.y, Math.max(5, 7 / scale), 0, 2 * Math.PI); ctx.fill();
      }}
      linkColor={link => highlightedLink(link) ? 'rgba(61,219,217,0.65)' : spotlight ? 'rgba(130,140,150,0.08)' : 'rgba(130,140,150,0.24)'}
      linkWidth={link => highlightedLink(link) ? 1.2 : 0.6} linkLineDash={link => isInferred(link) ? [3, 4] : null}
      linkCanvasObject={drawLinkFlow} linkCanvasObjectMode={() => 'after'}
      warmupTicks={reducedMotion || compact ? 180 : 40} cooldownTicks={reducedMotion || compact ? 0 : 180}
      cooldownTime={reducedMotion || compact ? 0 : 5000}
      d3AlphaDecay={0.035} d3VelocityDecay={0.4} minZoom={0.15} maxZoom={8}
      autoPauseRedraw={!animate}
      onNodeHover={node => { setHovered(node?.id ?? null); }}
      onNodeClick={node => { needsFit.current = false; onSelect(node); }}
      onNodeDrag={() => { needsFit.current = false; dragging.current = true; }}
      onNodeDragEnd={node => {
        if (node.x !== undefined) node.fx = node.x;
        if (node.y !== undefined) node.fy = node.y;
        if (node.x !== undefined && node.y !== undefined) {
          driftAnchors.current.set(node, { x: node.x, y: node.y, phase: motionPhase(node.id) * Math.PI * 2 });
        }
        dragging.current = false;
        layoutSettled.current = true;
      }}
      onLinkClick={link => { const edge = edges.find(e => e.id === link.id); if (edge) onEdge?.(edge); }}
      onEngineStop={() => {
        layoutSettled.current = true;
        for (const node of graph.nodes) {
          if (node.x === undefined || node.y === undefined) continue;
          node.fx = node.x; node.fy = node.y;
          driftAnchors.current.set(node, { x: node.x, y: node.y, phase: motionPhase(node.id) * Math.PI * 2 });
        }
        if (needsFit.current) { needsFit.current = false; fit(); }
      }} />
    <div className="atlas-force__tools" role="group" aria-label="Graph controls">
      <button type="button" aria-label="Zoom in" title="Zoom in"
        onClick={() => { const g = graphRef.current; if (g) g.zoom(Math.min(8, g.zoom() * 1.3), duration); }}>
        <ZoomIn size={16} aria-hidden="true" />
      </button>
      <button type="button" aria-label="Zoom out" title="Zoom out"
        onClick={() => { const g = graphRef.current; if (g) g.zoom(Math.max(0.15, g.zoom() / 1.3), duration); }}>
        <ZoomOut size={16} aria-hidden="true" />
      </button>
      <button type="button" aria-label="Fit graph" title="Fit graph" onClick={fit}>
        <FitToScreen size={16} aria-hidden="true" />
      </button>
      <button type="button" aria-label="Reflow graph" title="Reflow graph: release dragged nodes" onClick={() => {
        for (const node of graph.nodes) { delete node.fx; delete node.fy; }
        needsFit.current = true; graphRef.current?.d3ReheatSimulation();
      }}><Renew size={16} aria-hidden="true" /></button>
    </div>
    {hovered && <div className="atlas-force__hover">{nodes.find(n => n.id === hovered)?.title}</div>}
    {!compact && <p className="atlas-map__hint">Drag dots to arrange · scroll to zoom</p>}
  </div>;
}
