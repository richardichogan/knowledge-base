/**
 * pages/GraphPage.tsx
 * Full-viewport knowledge graph visualisation at /graph.
 * Manages all filter state, selection state, hover state, and
 * delegates rendering to GraphCanvas, GraphControls, GraphNodeDetail,
 * and GraphSelectionPanel.
 */
import React, { useState, useMemo, useCallback, useRef } from 'react';
import { Network_3 } from '@carbon/icons-react';
import { deferredView } from '../utils/deferredView';
import { GraphControls } from '../components/graph/GraphControls';
import { GraphNodeDetail } from '../components/graph/GraphNodeDetail';
import { GraphSelectionPanel } from '../components/graph/GraphSelectionPanel';
import { useGraphData } from '../hooks/useGraphData';
import type { GraphNode, GraphEdge } from '../services/api';
import { DataNotice } from '../components/DataNotice';
import { GraphRelationships } from '../components/graph/GraphRelationships';

const DEFAULT_DAYS = 30;
const DEFAULT_DEPTH = 2;
const EMPTY_NODES: GraphNode[] = [];
const EMPTY_EDGES: GraphEdge[] = [];
const GraphCanvas = deferredView('Graph canvas', async () => ({ default: (await import('../components/graph/GraphCanvas')).GraphCanvas }));

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
  const [confidenceThreshold, setConfidenceThreshold] = useState(0);
  const [releasePinsSignal,   setReleasePinsSignal]   = useState(0);
  const [colourMode, setColourMode]                   = useState<'type' | 'concept'>('type');
  const [view, setView] = useState<'canvas' | 'list'>('canvas');

  // ── Selection and hover ───────────────────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // hoveredId is tracked as a ref inside GraphCanvas — not page state
  const containerRef = useRef<HTMLDivElement>(null);

  const { data, isLoading, isError, error, retry } = useGraphData({ days, seed, depth: DEFAULT_DEPTH });

  const allNodes: GraphNode[] = data?.nodes ?? EMPTY_NODES;
  const allEdges: GraphEdge[] = data?.edges ?? EMPTY_EDGES;

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
  // Filter inferred edges below the confidence threshold
  const visibleEdges = useMemo(
    () => allEdges.filter(
      (e) => selectedEdgeTypes.includes(e.edgeType)
        && visibleNodeIds.has(e.source)
        && visibleNodeIds.has(e.target)
        && (e.edgeType !== 'thematically_related' || e.confidence >= confidenceThreshold),
    ),
    [allEdges, selectedEdgeTypes, visibleNodeIds, confidenceThreshold],
  );

  // ── Interaction handlers ───────────────────────────────────────────────────

  const handleNodeHover = useCallback((_node: GraphNode | null) => {
    // Hover is handled entirely inside GraphCanvas via ref — no page state needed
  }, []);

  const handleMouseMove = useCallback((_e: React.MouseEvent<HTMLDivElement>) => {
    // Tooltip positioning is handled inside GraphCanvas via a ref — no state update needed
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

  const handleReleasePins = useCallback(() => {
    setReleasePinsSignal((n) => n + 1);
  }, []);

  const handleReset = useCallback(() => {
    setDays(DEFAULT_DAYS);
    setSeed(null);
    setSelectedNodeTypes(allNodeTypes);
    setSelectedEdgeTypes(allEdgeTypes);
    setSearchQuery('');
    setConfidenceThreshold(0);
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
  if (isError && (data === null || allNodes.length === 0)) {
    return (
      <div className="graph-page graph-page--center">
        <DataNotice title="Graph data is unavailable" error={error} onRetry={() => { void retry(); }} />
      </div>
    );
  }
  if (allNodes.length === 0) {
    return (
      <div className="graph-page graph-page--center">
        <Network_3 size={48} className="graph-empty__icon" />
        <p className="graph-empty__label">NO CONNECTIONS YET</p>
        <p className="graph-empty__hint">No indexed connections in this date range. This does not mean there is no source content.</p>
        <button className="graph-controls__reset" onClick={() => { void retry(); }}>Refresh graph</button>
        {days !== 365 && <button className="graph-controls__reset" onClick={() => { setDays(365); }}>Look back one year</button>}
      </div>
    );
  }

  return (
    <div ref={containerRef} className={`graph-page${view === 'list' ? ' graph-page--list' : ''}`} onMouseMove={handleMouseMove}>
      {isError && <div className="graph-read-error"><DataNotice title="Graph refresh failed; showing previous data" error={error} onRetry={() => { void retry(); }} /></div>}
      {view === 'canvas' && <GraphCanvas
        nodes={visibleNodes}
        edges={visibleEdges}
        selectedIds={selectedIds}
        searchQuery={searchQuery}
        colourMode={colourMode}
        onNodeHover={handleNodeHover}
        onNodeClick={handleNodeClick}
        onNodeDblClick={handleNodeDblClick}
        onBackgroundClick={handleBackgroundClick}
        releasePinsSignal={releasePinsSignal}
      />}

      <GraphControls
        view={view}
        onViewChange={setView}
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
        onReleasePins={handleReleasePins}
        confidenceThreshold={confidenceThreshold}
        onConfidenceChange={setConfidenceThreshold}
        colourMode={colourMode}
        onColourModeChange={setColourMode}
        truncated={data?.stats.truncated ?? false}
        totalNodes={data?.stats.totalNodes ?? 0}
        filteredNodes={visibleNodes.length}
        nodes={visibleNodes}
        edges={visibleEdges}
      />
      {view === 'list' && <GraphRelationships nodes={visibleNodes} edges={visibleEdges} query={searchQuery}
        truncated={data?.stats.truncated ?? false} onSelect={(node) => { handleNodeClick(node, false); }} />}

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
