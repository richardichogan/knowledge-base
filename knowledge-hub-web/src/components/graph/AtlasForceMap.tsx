import React, { useEffect, useRef, useState } from 'react';
import { FitToScreen, Renew, ZoomIn, ZoomOut } from '@carbon/icons-react';
import { buildAtlasData, type AtlasData } from './atlasData';
import type { GraphNode, GraphEdge } from '../../services/api';

interface AtlasElement extends HTMLElement { data: AtlasData; cmd(command: string): void }
interface AtlasProps {
  nodes: GraphNode[]; edges: GraphEdge[]; selected: string | null;
  onSelect: (node: GraphNode | null) => void;
  compact?: boolean; scope?: string; depth?: number; data?: AtlasData;
  path?: string[]; hiddenTypes?: string[]; contextIds?: string[]; search?: string; range?: number; group?: string;
  fitVersion?: number;
}

export function AtlasForceMap({ nodes, edges, selected, onSelect, compact = false, scope = '', depth = 2,
  data, path = [], hiddenTypes = [], contextIds = [], search = '', range = 9999, group = '', fitVersion = 0 }: AtlasProps): React.ReactElement {
  const element = useRef<AtlasElement>(null);
  const [ready, setReady] = useState(() => typeof customElements !== 'undefined' && !!customElements.get('atlas-graph'));
  const [loadError, setLoadError] = useState(false);
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => { if (active && !customElements.get('atlas-graph')) setLoadError(true); }, 5000);
    void customElements.whenDefined('atlas-graph').then(() => {
      if (active) { setReady(true); setLoadError(false); window.clearTimeout(timer); }
    });
    return () => { active = false; window.clearTimeout(timer); };
  }, []);
  useEffect(() => {
    if (ready && element.current) element.current.data = data ?? buildAtlasData(nodes, edges);
  }, [ready, data, nodes, edges]);
  useEffect(() => { if (ready && fitVersion > 0) element.current?.cmd('fit'); }, [ready, fitVersion]);
  useEffect(() => {
    const el = element.current;
    if (!el) return;
    const select = (event: Event): void => {
      if (!(event instanceof CustomEvent)) return;
      const detail: unknown = event.detail;
      if (!detail || typeof detail !== 'object' || !('id' in detail)) return;
      const id = detail.id;
      if (id === null) onSelect(null);
      else if (typeof id === 'string') {
        const node = nodes.find(n => n.id === id);
        if (node) onSelect(node);
      }
    };
    el.addEventListener('atlas-select', select);
    return () => { el.removeEventListener('atlas-select', select); };
  }, [onSelect, nodes]);
  return <div className={`atlas-force${compact ? ' atlas-force--compact' : ''}`} role="region"
    aria-label={compact ? 'Note connections: interactive knowledge graph' : 'Interactive knowledge atlas'}>
    {React.createElement('atlas-graph', {
      ref: element, selected: selected ?? '', path: path.join(','), 'hide-types': hiddenTypes.join(','),
      context: contextIds.join(','), search, range: String(range), group, scope, depth: String(depth),
      ...(compact ? { compact: '' } : {}), 'aria-hidden': 'true',
    })}
    {loadError && <p className="atlas-force__error" role="alert">The graph renderer could not load. Reload the page or use the connected-record list.</p>}
    <div className="atlas-force__tools" role="group" aria-label="Graph controls">
      <button type="button" aria-label="Zoom in" title="Zoom in" disabled={!ready} onClick={() => { element.current?.cmd('in'); }}><ZoomIn size={16} /></button>
      <button type="button" aria-label="Zoom out" title="Zoom out" disabled={!ready} onClick={() => { element.current?.cmd('out'); }}><ZoomOut size={16} /></button>
      <button type="button" aria-label="Fit graph" title="Fit graph" disabled={!ready} onClick={() => { element.current?.cmd('fit'); }}><FitToScreen size={16} /></button>
      <button type="button" aria-label="Reflow graph" title="Reflow graph" disabled={!ready} onClick={() => { element.current?.cmd('reflow'); }}><Renew size={16} /></button>
    </div>
  </div>;
}
