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

export function AtlasForceMap({ nodes, edges, selected, focus, onSelect, onEdge, active, compact = false,
  colourMode = 'type' }: Omit<AtlasMapProps, 'layout'>): React.ReactElement {
  const container = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraphMethods<GraphNode, Omit<GraphEdge, 'source' | 'target'>>>();
  const needsFit = useRef(true);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [hovered, setHovered] = useState<string | null>(null);
  const [reducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const identity = useIdentity();
  const graph = useMemo<{ nodes: ForceNode[]; links: ForceLink[] }>(() => forceGraphData(nodes, edges), [nodes, edges]);
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
    needsFit.current = true;
    const renderer = graphRef.current;
    renderer?.d3Force('charge')?.strength(-100);
    renderer?.d3Force('link')?.distance(65).strength(0.3);
    renderer?.d3ReheatSimulation();
  }, [graph]);
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
    ctx.globalAlpha = spotlight && !highlighted ? 0.18 : 1;
    ctx.fillStyle = node.id === spotlight ? '#f4f4f4'
      : nodeColour(node.refType, node.conceptParent, colourMode, name => identity.byName(name)?.hex);
    ctx.beginPath(); ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI); ctx.fill();
    if (node.id === selected || active?.has(node.id)) {
      ctx.strokeStyle = active?.has(node.id) ? '#f1c21b' : '#3ddbd9'; ctx.lineWidth = 1 / scale;
      ctx.beginPath(); ctx.arc(node.x, node.y, radius + 3 / scale, 0, 2 * Math.PI); ctx.stroke();
    }
    ctx.globalAlpha = 1;
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
      warmupTicks={reducedMotion || compact ? 180 : 40} cooldownTicks={reducedMotion || compact ? 0 : 180}
      cooldownTime={reducedMotion || compact ? 0 : 5000}
      d3AlphaDecay={0.035} d3VelocityDecay={0.4} minZoom={0.15} maxZoom={8}
      onNodeHover={node => { setHovered(node?.id ?? null); }}
      onNodeClick={node => { needsFit.current = false; onSelect(node); }}
      onNodeDrag={() => { needsFit.current = false; }}
      onNodeDragEnd={node => {
        if (node.x !== undefined) node.fx = node.x;
        if (node.y !== undefined) node.fy = node.y;
      }}
      onLinkClick={link => { const edge = edges.find(e => e.id === link.id); if (edge) onEdge?.(edge); }}
      onEngineStop={() => { if (needsFit.current) { needsFit.current = false; fit(); } }} />
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
