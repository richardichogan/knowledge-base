import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { GraphNode, GraphEdge } from '../../services/api';
import { nodeColour } from './graphColour';
import { atlasBounds, edgeLabel, isInferred, placeAtlasLabels, type AtlasLayout } from './atlasModel';
import { useIdentity } from '../../identity';

export interface AtlasMapProps {
  nodes: GraphNode[]; edges: GraphEdge[]; layout: AtlasLayout; selected: string | null;
  onSelect: (node: GraphNode) => void; onEdge?: (edge: GraphEdge) => void;
  focus?: string | null; compact?: boolean; active?: Set<string> | null; colourMode?: 'type' | 'concept';
}

export function AtlasMap({ nodes, edges, layout, selected, onSelect, onEdge, focus, compact = false, active, colourMode = 'type' }: AtlasMapProps): React.ReactElement {
  const identity = useIdentity();
  const ref = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);
  const [camera, setCamera] = useState({ x: layout.width / 2, y: layout.height / 2, scale: 1 });
  const [hovered, setHovered] = useState<string | null>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const points = useMemo(() => nodes.flatMap(n => {
    const point = layout.positions.get(n.id); return point ? [point] : [];
  }), [nodes, layout]);
  const bounds = useMemo(() => atlasBounds(points, compact ? 50 : 90), [points, compact]);
  useEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: Math.max(1, entry.contentRect.width), height: Math.max(1, entry.contentRect.height) });
    });
    observer.observe(svg); return () => { observer.disconnect(); };
  }, []);
  useEffect(() => {
    const point = !compact && focus ? layout.positions.get(focus) : undefined;
    if (point) setCamera({ x: point.x, y: point.y, scale: Math.min(1.3, Math.max(bounds.width / size.width, bounds.height / size.height)) });
    else setCamera({ x: bounds.x, y: bounds.y, scale: Math.max(bounds.width / size.width, bounds.height / Math.max(100, size.height - 100)) });
  }, [focus, layout, bounds, size, compact]);
  const scale = camera.scale;
  const width = size.width * scale, height = size.height * scale;
  const zoom = (factor: number): void => { setCamera(c => ({ ...c, scale: Math.max(0.15, Math.min(50, c.scale / factor)) })); };
  useEffect(() => {
    const svg = ref.current;
    if (!svg || compact) return;
    const wheel = (event: WheelEvent): void => {
      event.preventDefault();
      const rect = svg.getBoundingClientRect(), dx = event.clientX - rect.left - rect.width / 2, dy = event.clientY - rect.top - rect.height / 2;
      setCamera(c => {
        const next = Math.max(0.15, Math.min(50, c.scale * Math.exp(Math.max(-100, Math.min(100, event.deltaY)) * 0.003)));
        return { x: c.x + dx * (c.scale - next), y: c.y + dy * (c.scale - next), scale: next };
      });
    };
    svg.addEventListener('wheel', wheel, { passive: false });
    return () => { svg.removeEventListener('wheel', wheel); };
  }, [compact]);
  const lit = hovered ?? selected;
  const neighbours = new Set<string>(lit ? [lit] : []);
  for (const edge of edges) {
    if (edge.source === lit) neighbours.add(edge.target);
    if (edge.target === lit) neighbours.add(edge.source);
  }
  const nodeIds = new Set(nodes.map(n => n.id));
  const labels = placeAtlasLabels([...nodes].sort((a, b) =>
    Number(b.id === lit) - Number(a.id === lit) || Number(neighbours.has(b.id)) - Number(neighbours.has(a.id))
    || Number(b.refType === 'project') - Number(a.refType === 'project') || a.id.localeCompare(b.id))
    .flatMap(n => {
      const p = layout.positions.get(n.id);
      return p ? [{ id: n.id, text: n.title, x: (p.x - camera.x) / scale + size.width / 2, y: (p.y - camera.y) / scale + size.height / 2 }] : [];
    }), size.width, size.height);
  return <div className={`atlas-map${compact ? ' atlas-map--compact' : ''}`}>
    {!compact && <div className="atlas-map__tools" aria-label="Map navigation">
      <button onClick={() => { zoom(1.35); }} aria-label="Zoom in">+</button>
      <button onClick={() => { zoom(1 / 1.35); }} aria-label="Zoom out">−</button>
      <button onClick={() => { setCamera({ x: bounds.x, y: bounds.y, scale: Math.max(bounds.width / size.width, bounds.height / Math.max(100, size.height - 100)) }); }}>Fit map</button>
      {selected && <button onClick={() => {
        const point = layout.positions.get(selected);
        if (point) setCamera({ x: point.x, y: point.y, scale: 1 });
      }}>Fit selection</button>}
    </div>}
    <svg ref={ref} className="atlas-map__svg" viewBox={`${camera.x - width / 2} ${camera.y - height / 2} ${width} ${height}`}
      aria-label={compact ? 'Note neighbourhood' : 'Knowledge atlas. Drag the background to pan; use zoom buttons to explore.'}
      onPointerDown={event => {
        if (compact || event.button !== 0) return;
        drag.current = { x: event.clientX, y: event.clientY, cx: camera.x, cy: camera.y };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        if (drag.current) setCamera(c => ({ ...c, x: drag.current!.cx - (event.clientX - drag.current!.x) * scale,
          y: drag.current!.cy - (event.clientY - drag.current!.y) * scale }));
      }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
      {!compact && layout.clusters.filter(cluster => cluster.count > 1).map(cluster => <g key={cluster.id} className="atlas-map__cluster">
        <circle cx={cluster.x} cy={cluster.y} r={cluster.radius} />
      </g>)}
      {edges.filter(e => nodeIds.has(e.source) && nodeIds.has(e.target)).map(edge => {
        const a = layout.positions.get(edge.source), b = layout.positions.get(edge.target);
        if (!a || !b) return null;
        const highlighted = edge.source === lit || edge.target === lit;
        return <g key={edge.id} className={`atlas-map__edge${highlighted ? ' atlas-map__edge--lit' : ''}${isInferred(edge) ? ' atlas-map__edge--inferred' : ''}`}
          opacity={lit && !highlighted ? 0.15 : 1}>
          <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} vectorEffect="non-scaling-stroke" />
          {onEdge && <line className="atlas-map__edge-hit" x1={a.x} y1={a.y} x2={b.x} y2={b.y} vectorEffect="non-scaling-stroke"
            role="button" tabIndex={highlighted ? 0 : -1} aria-label={`Inspect ${edgeLabel(edge)} connection`}
            onPointerDown={event => { event.stopPropagation(); }} onClick={() => { onEdge(edge); }}
            onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onEdge(edge); } }} />}
        </g>;
      })}
      {nodes.map(node => {
        const point = layout.positions.get(node.id);
        if (!point) return null;
        const isSelected = node.id === selected;
        const radius = isSelected ? 9 * scale : compact ? 6 * scale : Math.max(1.7 * scale, Math.min((node.refType === 'project' ? 9 : 6) * scale, 13));
        return <g key={node.id} role="button" tabIndex={0} aria-label={`${node.title}, ${node.refType}`}
          className={`atlas-map__node${isSelected ? ' atlas-map__node--selected' : ''}${active?.has(node.id) ? ' atlas-map__node--active' : ''}`}
          transform={`translate(${point.x} ${point.y})`} opacity={lit && !neighbours.has(node.id) ? 0.24 : 1}
          onPointerDown={event => { event.stopPropagation(); }} onClick={() => { onSelect(node); }}
          onMouseEnter={() => { setHovered(node.id); }} onMouseLeave={() => { setHovered(null); }}
          onFocus={() => { setHovered(node.id); }} onBlur={() => { setHovered(null); }}
          onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(node); } }}>
          <title>{`${node.title} (${node.refType})`}</title>
          <circle r={radius + 3 * scale} className="atlas-map__ring" vectorEffect="non-scaling-stroke" />
          <circle r={radius} fill={nodeColour(node.refType, node.conceptParent, colourMode, name => identity.byName(name)?.hex)} />
        </g>;
      })}
    </svg>
    <div className="atlas-labels" aria-label="Visible record labels">{labels.map(label => <button key={label.id}
      className={`atlas-labels__item${label.id === selected ? ' atlas-labels__item--selected' : ''}`}
      style={{ left: label.x, top: label.y, width: label.width }} title={label.text}
      onClick={() => { const node = nodes.find(n => n.id === label.id); if (node) onSelect(node); }}>{label.text}</button>)}</div>
    {!compact && <p className="atlas-map__hint">Scroll to zoom · drag to pan · select a name or dot to focus</p>}
  </div>;
}
