import React, { useMemo, useState } from 'react';
import type { GraphEdge, GraphNode } from '../../services/api';

const PAGE_SIZE = 50;

export const GraphRelationships: React.FC<{
  nodes: GraphNode[]; edges: GraphEdge[]; query: string; truncated: boolean;
  onSelect: (node: GraphNode) => void;
}> = ({ nodes, edges, query, truncated, onSelect }) => {
  const [page, setPage] = useState(1);
  const byId = useMemo(() => new Map(nodes.map(node => [node.id, node])), [nodes]);
  const rows = useMemo(() => {
    const matches = (node: GraphNode): boolean => node.title.toLowerCase().includes(query.trim().toLowerCase());
    const linked = new Set(edges.flatMap(edge => [edge.source, edge.target]));
    const relationships: Array<{ id: string; source: GraphNode; target?: GraphNode; edge?: GraphEdge }> = [];
    for (const edge of edges) {
      const source = byId.get(edge.source);
      const target = byId.get(edge.target);
      if (source && target && (matches(source) || matches(target))) relationships.push({ id: edge.id, source, target, edge });
    }
    for (const node of nodes) {
      if (!linked.has(node.id) && matches(node)) relationships.push({ id: `node:${node.id}`, source: node });
    }
    return relationships;
  }, [nodes, edges, query, byId]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages);
  const offset = (currentPage - 1) * PAGE_SIZE;

  return <section className="graph-relationships" aria-label="Graph relationships">
    <h1>Relationships</h1>
    <p className="graph-relationships__coverage">
      Loaded indexed data, not an exhaustive view of your sources.
      {truncated ? ' The server truncated this graph; some nodes and relationships are omitted.' : ''}
      {' '}{rows.length} matching relationships or unconnected nodes.
    </p>
    {rows.length === 0 ? <p className="graph-relationships__empty">No matches in the loaded graph. Adjust the filters or search.</p>
      : <ul className="graph-relationships__rows">
        {rows.slice(offset, offset + PAGE_SIZE).map(row => <li key={row.id} className="graph-relationships__row">
          <button className="graph-relationships__node" onClick={() => { onSelect(row.source); }}>{row.source.title}</button>
          {row.edge && <span className="graph-relationships__type">
            {row.edge.edgeType.replaceAll('_', ' ')}
            {row.edge.edgeType === 'thematically_related' ? ` (inferred, ${Math.round(row.edge.confidence * 100)}% confidence)` : ''}
          </span>}
          {row.target ? <button className="graph-relationships__node" onClick={() => { if (row.target) onSelect(row.target); }}>
            {row.target.title}</button> : <span className="graph-relationships__type">No visible relationships</span>}
        </li>)}
      </ul>}
    {pages > 1 && <nav className="graph-relationships__pagination" aria-label="Relationship pages">
      <button className="graph-controls__reset" disabled={currentPage === 1} onClick={() => { setPage(currentPage - 1); }}>Previous</button>
      <span>Page {currentPage} of {pages}</span>
      <button className="graph-controls__reset" disabled={currentPage === pages} onClick={() => { setPage(currentPage + 1); }}>Next</button>
    </nav>}
  </section>;
};
