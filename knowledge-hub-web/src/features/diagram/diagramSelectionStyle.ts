import type { DiagramDocument, DiagramEdge, DiagramNode } from './diagramTypes';
import { diagramEditorNodeColours } from './diagramTheme';

export type DiagramNodeStyle = Partial<Pick<DiagramNode, 'fill' | 'stroke' | 'textColor' | 'strokeWidth' | 'strokeStyle' | 'fontSize' | 'textAlign' | 'textVerticalAlign'>>;
export type DiagramEdgeStyle = Partial<Pick<DiagramEdge, 'stroke' | 'strokeWidth' | 'dashed' | 'fontSize' | 'arrows'>>;

export function commonStyleValue<T>(values: readonly T[]): T | undefined {
  return values.length > 0 && values.every(value => value === values[0]) ? values[0] : undefined;
}

/** One document change keeps a mixed shape/connector style edit in one undo step. */
export function applyDiagramSelectionStyle(
  doc: DiagramDocument, selection: { nodes: readonly string[]; edges: readonly string[] },
  nodeStyle: DiagramNodeStyle, edgeStyle: DiagramEdgeStyle,
): DiagramDocument {
  const nodes = new Set(selection.nodes);
  const edges = new Set(selection.edges);
  return {
    ...doc,
    nodes: doc.nodes.map(node => {
      if (!nodes.has(node.id)) return node;
      const { fill, ...style } = nodeStyle;
      return { ...node, ...(fill !== undefined && node.kind !== 'line'
        ? { fill, textColor: diagramEditorNodeColours(node).textColor } : {}), ...style };
    }),
    edges: doc.edges.map(edge => edges.has(edge.id) ? { ...edge, ...edgeStyle } : edge),
  };
}
