import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph3D, { type ForceGraphMethods, type NodeObject } from 'react-force-graph-3d';
import type { GraphNode, GraphEdge } from '../../services/api';
import { atlasBounds, isInferred, placeAtlasLabels, type AtlasLabel, type AtlasPoint } from './atlasModel';
import { nodeColour } from './graphColour';
import { useIdentity } from '../../identity';
import type { AtlasMapProps } from './AtlasMap';

interface SpaceNode extends GraphNode { x: number; y: number; z: number; fx: number; fy: number; fz: number }
type SpaceLink = Omit<GraphEdge, 'source' | 'target'>;
function isPoint(value: unknown): value is AtlasPoint {
  return typeof value === 'object' && value !== null && 'x' in value && typeof value.x === 'number'
    && 'y' in value && typeof value.y === 'number' && 'z' in value && typeof value.z === 'number';
}

export function AtlasSpace({ nodes, edges, layout, selected, focus, onSelect, onEdge, colourMode = 'type' }: AtlasMapProps): React.ReactElement {
  const ref = useRef<ForceGraphMethods<SpaceNode, SpaceLink> | undefined>(undefined);
  const container = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [lost, setLost] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const [labels, setLabels] = useState<AtlasLabel[]>([]);
  const identity = useIdentity();
  const graph = useMemo(() => ({
    nodes: nodes.map(node => {
      const p = layout.positions.get(node.id) ?? { x: 0, y: 0, z: 0 };
      const x = p.x - layout.width / 2, y = layout.height / 2 - p.y;
      return { ...node, x, y, z: p.z, fx: x, fy: y, fz: p.z };
    }),
    links: edges.map(edge => ({ ...edge })),
  }), [nodes, edges, layout]);
  const bounds = useMemo(() => atlasBounds(graph.nodes, 90), [graph]);
  const neighbours = useMemo(() => {
    const result = new Set(selected ? [selected] : []);
    for (const edge of edges) {
      if (edge.source === selected) result.add(edge.target);
      if (edge.target === selected) result.add(edge.source);
    }
    return result;
  }, [selected, edges]);
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: Math.max(1, entry.contentRect.width), height: Math.max(1, entry.contentRect.height) });
    });
    const onLost = (event: Event): void => { event.preventDefault(); setLost(true); };
    el.addEventListener('webglcontextlost', onLost, true);
    observer.observe(el);
    return () => { observer.disconnect(); el.removeEventListener('webglcontextlost', onLost, true); };
  }, []);
  const fit = useCallback((): void => {
    const distance = Math.max(bounds.height, bounds.width / (size.width / size.height)) * 1.7 + bounds.depth / 2;
    ref.current?.cameraPosition({ x: bounds.x, y: bounds.y, z: bounds.z + distance }, bounds, 0);
  }, [bounds, size]);
  useEffect(() => {
    const node = graph.nodes.find(n => n.id === focus);
    const timer = requestAnimationFrame(() => {
      if (node) ref.current?.cameraPosition({ x: node.x, y: node.y, z: node.z + 650 }, node, 0);
      else fit();
    });
    return () => { cancelAnimationFrame(timer); };
  }, [focus, graph, fit]);
  useEffect(() => {
    let frame = 0, lastUpdate = 0;
    const candidates = [...graph.nodes].filter(n => !selected || neighbours.has(n.id) || n.id === hovered).sort((a, b) =>
      Number(b.id === selected) - Number(a.id === selected) || Number(b.id === hovered) - Number(a.id === hovered)
      || Number(b.refType === 'project') - Number(a.refType === 'project') || a.id.localeCompare(b.id));
    const update = (time: number): void => {
      const renderer = ref.current;
      if (renderer && time - lastUpdate > 80) {
        lastUpdate = time;
        const camera = renderer.camera();
        const projected = candidates.flatMap(n => {
          const p = camera.position.clone().set(n.x, n.y, n.z).project(camera);
          if (p.z < -1 || p.z > 1) return [];
          return [{ id: n.id, text: n.title, x: (p.x + 1) * size.width / 2, y: (1 - p.y) * size.height / 2 }];
        });
        const next = placeAtlasLabels(projected, size.width, size.height);
        setLabels(previous => previous.length === next.length && previous.every((l, i) => {
          const n = next[i]; return n?.id === l.id && Math.abs(n.x - l.x) < 0.5 && Math.abs(n.y - l.y) < 0.5;
        }) ? previous : next);
      }
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => { cancelAnimationFrame(frame); };
  }, [graph, selected, hovered, neighbours, size]);
  function zoom(factor: number): void {
    const renderer = ref.current;
    if (!renderer) return;
    const controls = renderer.controls();
    const target = 'target' in controls && isPoint(controls.target) ? controls.target : bounds;
    const position = renderer.camera().position;
    renderer.cameraPosition({ x: target.x + (position.x - target.x) * factor,
      y: target.y + (position.y - target.y) * factor, z: target.z + (position.z - target.z) * factor }, target, 0);
  }
  function label(node: NodeObject<SpaceNode>): string {
    const el = document.createElement('span');
    el.className = 'atlas-space__label';
    el.textContent = `${node.title} · ${node.refType}`;
    return el.outerHTML;
  }
  return <div ref={container} className="atlas-space">
    {lost ? <p role="alert">3D graphics became unavailable. Switch to Map or Relationships to continue.</p> : <>
      <ForceGraph3D<SpaceNode, SpaceLink> ref={ref} graphData={graph} width={size.width} height={size.height}
        backgroundColor="#161616" showNavInfo={false} enableNodeDrag={false} cooldownTicks={0}
        nodeRelSize={selected ? 5 : Math.max(4, Math.max(bounds.width, bounds.height) / 170)}
        nodeColor={node => node.id === selected ? '#ffffff' : selected && !neighbours.has(node.id) ? '#41464b'
          : nodeColour(node.refType, node.conceptParent, colourMode, name => identity.byName(name)?.hex)}
        nodeVal={node => node.refType === 'project' ? 9 : 3} nodeLabel={label}
        linkColor={link => isInferred(link) ? '#777777' : '#7a9997'} linkOpacity={0.65}
        linkVisibility={link => !selected || (typeof link.source === 'object' ? link.source.id : link.source) === selected
          || (typeof link.target === 'object' ? link.target.id : link.target) === selected}
        linkWidth={link => (typeof link.source === 'object' ? link.source.id : link.source) === selected
          || (typeof link.target === 'object' ? link.target.id : link.target) === selected ? 2 : Math.max(1, bounds.width / 900)}
        onNodeClick={node => { onSelect(node); }}
        onNodeHover={node => { setHovered(node?.id ?? null); }}
        onLinkClick={link => {
          const edge = edges.find(e => e.id === link.id);
          if (edge) onEdge?.(edge);
        }} />
      <div className="atlas-labels" aria-label="Visible record labels">{labels.map(l => <button key={l.id}
        className={`atlas-labels__item${l.id === selected ? ' atlas-labels__item--selected' : ''}`}
        style={{ left: l.x, top: l.y, width: l.width }} title={l.text}
        onClick={() => { const node = nodes.find(n => n.id === l.id); if (node) onSelect(node); }}>{l.text}</button>)}</div>
      <div className="atlas-map__tools">
        <button onClick={() => { zoom(0.7); }} aria-label="Zoom in 3D">+</button>
        <button onClick={() => { zoom(1.4); }} aria-label="Zoom out 3D">−</button>
        <button onClick={fit}>Fit 3D</button>
        {selected && <button onClick={() => {
          const node = graph.nodes.find(n => n.id === selected);
          if (node) ref.current?.cameraPosition({ x: node.x, y: node.y, z: node.z + 650 }, node, 0);
        }}>Focus selection</button>}
      </div>
      <p className="atlas-map__hint">Drag to orbit · scroll to zoom · right-drag to pan · select a name to focus</p>
    </>}
  </div>;
}
