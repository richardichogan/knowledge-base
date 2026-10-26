import type { DiagramDocument, DiagramEdge, DiagramNode } from './diagramTypes';
import { diagramEditorNodeColours, diagramEdgeAppearance } from './diagramTheme';

export type DiagramNodeStyle = Partial<Pick<DiagramNode, 'fill' | 'stroke' | 'textColor' | 'strokeWidth' | 'strokeStyle' | 'fontSize' | 'textAlign' | 'textVerticalAlign'>>;
export type DiagramEdgeStyle = Partial<Pick<DiagramEdge, 'stroke' | 'strokeWidth' | 'dashed' | 'fontSize' | 'arrows'>>;

export function commonStyleValue<T>(values: readonly T[]): T | undefined {
  return values.length > 0 && values.every(value => value === values[0]) ? values[0] : undefined;
}

export function applyDiagramEdgeStyle(edge: DiagramEdge, style: DiagramEdgeStyle): DiagramEdge {
  if (Object.keys(style).length === 0) return edge;
  const appearance = diagramEdgeAppearance(edge);
  return { ...edge, stroke: appearance.stroke, dashed: appearance.dash !== undefined, strokeWidth: appearance.width, ...style };
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
      const colours = (fill !== undefined && node.kind !== 'line') || style.stroke !== undefined || style.textColor !== undefined
        ? diagramEditorNodeColours(node) : {};
      return { ...node, ...colours, ...(fill !== undefined && node.kind !== 'line' ? { fill } : {}), ...style };
    }),
    edges: doc.edges.map(edge => edges.has(edge.id) ? applyDiagramEdgeStyle(edge, edgeStyle) : edge),
  };
}
