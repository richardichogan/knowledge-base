/**
 * components/graph/GraphControls.tsx
 * Floating control panel over the top-left of the graph canvas.
 * Collapsible. Contains date range slider, node/edge type filters, search, and reset.
 */
import React, { useState } from 'react';
import { Search } from '@carbon/react';
import type { GraphNode, GraphEdge } from '../../services/api';

const EDGE_LABELS: Record<string, string> = {
  has_spark:            'Sparks',
  tag_overlap:          'Shared tags',
  references:           'References',
  thematically_related: 'Thematic',
};

interface GraphControlsProps {
  days: number;
  onDaysChange: (v: number) => void;
  allNodeTypes: string[];
  selectedNodeTypes: string[];
  onNodeTypesChange: (v: string[]) => void;
  allEdgeTypes: string[];
  selectedEdgeTypes: string[];
  onEdgeTypesChange: (v: string[]) => void;
  searchQuery: string;
  onSearchChange: (v: string) => void;
  onReset: () => void;
  onReleasePins: () => void;
  confidenceThreshold: number;
  onConfidenceChange: (v: number) => void;
  colourMode: 'type' | 'concept';
  onColourModeChange: (v: 'type' | 'concept') => void;
  truncated: boolean;
  totalNodes: number;
  filteredNodes: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * Collapsible floating control panel for the graph visualisation.
 */
export const GraphControls: React.FC<GraphControlsProps> = ({
  days, onDaysChange,
  allNodeTypes, selectedNodeTypes, onNodeTypesChange,
  allEdgeTypes, selectedEdgeTypes, onEdgeTypesChange,
  searchQuery, onSearchChange,
  onReset, onReleasePins, confidenceThreshold, onConfidenceChange,
  colourMode, onColourModeChange,
  truncated, totalNodes,
}) => {
  const [collapsed, setCollapsed] = useState(false);
  // Buffer both sliders locally — only fire the fetch-triggering callback on mouseUp
  const [localDays, setLocalDays]               = useState(days);
  const [localConfidence, setLocalConfidence]   = useState(Math.round(confidenceThreshold * 100));

  function toggleNodeType(type: string): void {
    if (selectedNodeTypes.includes(type)) {
      onNodeTypesChange(selectedNodeTypes.filter((t) => t !== type));
    } else {
      onNodeTypesChange([...selectedNodeTypes, type]);
    }
  }

  function toggleEdgeType(type: string): void {
    if (selectedEdgeTypes.includes(type)) {
      onEdgeTypesChange(selectedEdgeTypes.filter((t) => t !== type));
    } else {
      onEdgeTypesChange([...selectedEdgeTypes, type]);
    }
  }

  return (
    <div className={`graph-controls${collapsed ? ' graph-controls--collapsed' : ''}`}>
      <div className="graph-controls__header">
        <span className="graph-controls__title">Graph</span>
        <button
          className="graph-controls__chevron"
          onClick={() => { setCollapsed((v) => !v); }}
          aria-label={collapsed ? 'Expand controls' : 'Collapse controls'}
        >
          {collapsed ? '▸' : '▾'}
        </button>
      </div>

      {!collapsed && (
        <div className="graph-controls__body">
          <div className="graph-controls__section">
            <p className="graph-controls__label">Colour by</p>
            <div className="graph-controls__chips">
              {(['type', 'concept'] as const).map((m) => (
                <button
                  key={m}
                  className={`graph-controls__chip${colourMode === m ? ' graph-controls__chip--active' : ''}`}
                  onClick={() => { onColourModeChange(m); }}
                >
                  {m === 'type' ? 'Type' : 'Concept area'}
                </button>
              ))}
            </div>
          </div>

          <div className="graph-controls__section">
            <label className="graph-controls__label" htmlFor="graph-days-slider">
              Last {localDays} day{localDays !== 1 ? 's' : ''}
            </label>
            <input
              id="graph-days-slider"
              type="range"
              min={1}
              max={365}
              value={localDays}
              onChange={(e) => { setLocalDays(parseInt(e.target.value, 10)); }}
              onMouseUp={(e) => { onDaysChange(parseInt((e.target as HTMLInputElement).value, 10)); }}
              onTouchEnd={(e) => { onDaysChange(parseInt((e.target as HTMLInputElement).value, 10)); }}
              className="graph-controls__slider"
            />
          </div>

          <div className="graph-controls__section">
            <p className="graph-controls__label">Node types</p>
            <div className="graph-controls__chips">
              {allNodeTypes.map((t) => (
                <button
                  key={t}
                  className={`graph-controls__chip${selectedNodeTypes.includes(t) ? ' graph-controls__chip--active' : ''}`}
                  onClick={() => { toggleNodeType(t); }}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          <div className="graph-controls__section">
            <p className="graph-controls__label">Edge types</p>
            <div className="graph-controls__chips">
              {allEdgeTypes.map((t) => (
                <button
                  key={t}
                  className={`graph-controls__chip${selectedEdgeTypes.includes(t) ? ' graph-controls__chip--active' : ''}`}
                  onClick={() => { toggleEdgeType(t); }}
                >
                  {EDGE_LABELS[t] ?? t}
                </button>
              ))}
            </div>
          </div>

          <div className="graph-controls__section">
            <Search
              id="graph-search"
              labelText="Search nodes"
              placeholder="Search nodes…"
              size="sm"
              value={searchQuery}
              onChange={(e) => { onSearchChange(e.target.value); }}
            />
          </div>

          <button className="graph-controls__reset" onClick={onReset}>
            Reset
          </button>

          <div className="graph-controls__section">
            <label className="graph-controls__label" htmlFor="graph-confidence-slider">
              Min confidence: {localConfidence}%
            </label>
            <input
              id="graph-confidence-slider"
              type="range"
              min={0}
              max={100}
              value={localConfidence}
              onChange={(e) => { setLocalConfidence(parseInt(e.target.value, 10)); }}
              onMouseUp={(e) => { onConfidenceChange(parseInt((e.target as HTMLInputElement).value, 10) / 100); }}
              onTouchEnd={(e) => { onConfidenceChange(parseInt((e.target as HTMLInputElement).value, 10) / 100); }}
              className="graph-controls__slider"
            />
          </div>

          <button className="graph-controls__reset" onClick={onReleasePins}>
            Release pins
          </button>

          {truncated && (
            <p className="graph-controls__truncation">
              Showing 500 of {totalNodes} nodes. Narrow the date range or filter by node type to see the full set.
            </p>
          )}
        </div>
      )}
    </div>
  );
};
