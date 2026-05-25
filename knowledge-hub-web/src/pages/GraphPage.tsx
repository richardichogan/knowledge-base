/**
 * pages/GraphPage.tsx
 * Full-viewport knowledge graph visualisation at /graph.
 * Manages all filter state, selection state, hover state, and
 * delegates rendering to GraphCanvas, GraphControls, GraphNodeDetail,
 * and GraphSelectionPanel.
 */
import React, { useState, useMemo, useCallback, useRef } from 'react';
import { Network_3 } from '@carbon/icons-react';
import { GraphCanvas } from '../components/graph/GraphCanvas';
import { GraphControls } from '../components/graph/GraphControls';
import { GraphNodeDetail } from '../components/graph/GraphNodeDetail';
import { GraphSelectionPanel } from '../components/graph/GraphSelectionPanel';
import { useGraphData } from '../hooks/useGraphData';
import type { GraphNode, GraphEdge } from '../services/api';

const DEFAULT_DAYS = 30;
const DEFAULT_DEPTH = 2;

/**
 * Returns unique values from an array, preserving order.
 */
function unique(items: string[]): string[] {
  return Array.from(new Set(items));
}

/**
 * Top-level graph page. Full viewport, header remains visible.
 */
export const GraphPage: React.FC = () => {
  // ── Fetch params (trigger re-fetch) ───────────────────────────────────────
  const [days, setDays]     = useState(DEFAULT_DAYS);
  const [seed, setSeed]     = useState<string | null>(null);

  // ── Client-side filters (no re-fetch) ────────────────────────────────────
  const [selectedNodeTypes, setSelectedNodeTypes] = useState<string[]>([]);
  const [selectedEdgeTypes, setSelectedEdgeTypes] = useState<string[]>([]);
  const [searchQuery, setSearchQuery]             = useState('');

  // ── Selection and hover ───────────────────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [hoveredId,   setHoveredId]   = useState<string | null>(null);
  const [hoveredPos,  setHoveredPos]  = useState({ x: 0, y: 0 });

  const containerRef = useRef<HTMLDivElement>(null);

  const { data, isLoading, isError } = useGraphData({ days, seed, depth: DEFAULT_DEPTH });

  const allNodes: GraphNode[] = data?.nodes ?? [];
  const allEdges: GraphEdge[] = data?.edges ?? [];

  const allNodeTypes = useMemo(() => unique(allNodes.map((n) => n.refType)), [allNodes]);
  const allEdgeTypes = useMemo(() => unique(allEdges.map((e) => e.edgeType)), [allEdges]);

  // Initialise type filters when data first loads
  React.useEffect(() => {
    if (allNodeTypes.length > 0 && selectedNodeTypes.length === 0) setSelectedNodeTypes(allNodeTypes);
    if (allEdgeTypes.length > 0 && selectedEdgeTypes.length === 0) setSelectedEdgeTypes(allEdgeTypes);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allNodeTypes.join(','), allEdgeTypes.join(',')]);

  // Apply client-side filters
  const visibleNodes = useMemo(
    () => allNodes.filter((n) => selectedNodeTypes.includes(n.refType)),
    [allNodes, selectedNodeTypes],
  );
  const visibleNodeIds = useMemo(() => new Set(visibleNodes.map((n) => n.id)), [visibleNodes]);
  const visibleEdges = useMemo(
    () => allEdges.filter(
      (e) => selectedEdgeTypes.includes(e.edgeType)
        && visibleNodeIds.has(e.source)
        && visibleNodeIds.has(e.target),
    ),
    [allEdges, selectedEdgeTypes, visibleNodeIds],
  );

  // ── Interaction handlers ───────────────────────────────────────────────────

  const handleNodeHover = useCallback((node: GraphNode | null) => {
    setHoveredId(node?.id ?? null);
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = containerRef.current?.getBoundingClientRect();
    setHoveredPos({ x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) });
  }, []);

  const handleNodeClick = useCallback((node: GraphNode, shiftKey: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (shiftKey) {
        if (next.has(node.id)) next.delete(node.id); else next.add(node.id);
      } else {
        next.clear();
        next.add(node.id);
      }
      return next;
    });
  }, []);

  const handleNodeDblClick = useCallback((node: GraphNode) => {
    setSeed(node.id);
    setSelectedIds(new Set([node.id]));
  }, []);

  const handleBackgroundClick = useCallback(() => { setSelectedIds(new Set()); }, []);

  const handleReset = useCallback(() => {
    setDays(DEFAULT_DAYS);
    setSeed(null);
    setSelectedNodeTypes(allNodeTypes);
    setSelectedEdgeTypes(allEdgeTypes);
    setSearchQuery('');
    setSelectedIds(new Set());
  }, [allNodeTypes, allEdgeTypes]);

  const handleStartHere = useCallback((nodeId: string) => {
    setSeed(nodeId);
    setSelectedIds(new Set([nodeId]));
  }, []);

  // ── Selection panel ────────────────────────────────────────────────────────
  const selectedNodes = visibleNodes.filter((n) => selectedIds.has(n.id));
  const singleSelected = selectedNodes.length === 1 ? (selectedNodes[0] ?? null) : null;
  const multiSelected  = selectedNodes.length >= 2 ? selectedNodes : null;

  // ── Empty / loading states ─────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="graph-page graph-page--center">
        <p className="graph-empty__hint">Loading graph…</p>
      </div>
    );
  }
  if (isError) {
    return (
      <div className="graph-page graph-page--center">
        <p className="graph-empty__hint">Failed to load graph data.</p>
      </div>
    );
  }
  if (allNodes.length === 0) {
    return (
      <div className="graph-page graph-page--center">
        <Network_3 size={48} className="graph-empty__icon" />
        <p className="graph-empty__label">NO CONNECTIONS YET</p>
        <p className="graph-empty__hint">Run npm run graph:backfill to populate the graph.</p>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="graph-page" onMouseMove={handleMouseMove}>
      <GraphCanvas
        nodes={visibleNodes}
        edges={visibleEdges}
        selectedIds={selectedIds}
        searchQuery={searchQuery}
        hoveredId={hoveredId}
        hoveredPos={hoveredPos}
        onNodeHover={handleNodeHover}
        onNodeClick={handleNodeClick}
        onNodeDblClick={handleNodeDblClick}
        onBackgroundClick={handleBackgroundClick}
      />

      <GraphControls
        days={days}
        onDaysChange={setDays}
        allNodeTypes={allNodeTypes}
        selectedNodeTypes={selectedNodeTypes}
        onNodeTypesChange={setSelectedNodeTypes}
        allEdgeTypes={allEdgeTypes}
        selectedEdgeTypes={selectedEdgeTypes}
        onEdgeTypesChange={setSelectedEdgeTypes}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onReset={handleReset}
        truncated={data?.stats.truncated ?? false}
        totalNodes={data?.stats.totalNodes ?? 0}
        filteredNodes={visibleNodes.length}
        nodes={visibleNodes}
        edges={visibleEdges}
      />

      {singleSelected !== null && (
        <GraphNodeDetail
          node={singleSelected}
          edges={visibleEdges}
          onStartHere={handleStartHere}
          onClose={() => { setSelectedIds(new Set()); }}
        />
      )}

      {multiSelected !== null && (
        <GraphSelectionPanel
          nodes={multiSelected}
          onClose={() => { setSelectedIds(new Set()); }}
        />
      )}
    </div>
  );
};
