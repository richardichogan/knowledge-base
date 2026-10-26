import { EDGE_STYLES, STEP_STYLES } from './aiFlow';
import type { DiagramEdge, DiagramKind, DiagramNode } from './diagramTypes';

// The modern finish is shared by the editor and image exports, never written
// back on load. Recognise shipped defaults; preserve other authored colours.
const LIGHT_FILLS: Record<string, string> = {
  '#262626': '#ffffff', '#1c2d4a': '#a6c8ff', '#173b27': '#6fdc8c', '#3d3215': '#f1c21b',
  '#442027': '#ffb3b8', '#302342': '#d4bbff', '#202020': '#f4f4f4',
  '#0f3433': '#3ddbd9', '#3e1a2b': '#ffafd2',
  '#012749': '#82cfff', '#3e1a00': '#ffb784',
  '#edf5ff': '#a6c8ff', '#f6f2ff': '#d4bbff', '#e5f6ff': '#82cfff',
  '#d9fbfb': '#3ddbd9', '#defbe6': '#6fdc8c', '#fff0f7': '#ffafd2',
  '#fff1f1': '#ffb3b8', '#fcf4d6': '#f1c21b', '#fff2e8': '#ffb784',
};
const LIGHT_INK: Record<string, string> = {
  '#f4f4f4': '#161616', '#fff': '#161616', '#ffffff': '#161616', white: '#161616',
  '#c6c6c6': '#525252',
  '#78a9ff': '#0f62fe',
  '#6fdc8c': '#198038',
  '#f1c21b': '#b28600',
  '#ff8389': '#da1e28',
  '#be95ff': '#8a3ffc',
  '#3ddbd9': '#007d79',
  '#ff7eb6': '#d02670',
  '#a8a8a8': '#6f6f6f',
  '#82cfff': '#1192e8',
  '#ffb784': '#eb6200',
};

export function diagramEditorInk(colour: string): string {
  return LIGHT_INK[colour.toLowerCase()] ?? colour;
}

export function diagramEditorFill(colour: string): string {
  return LIGHT_FILLS[colour.toLowerCase()] ?? colour;
}

type ColouredNode = Pick<DiagramNode, 'fill' | 'stroke' | 'textColor'> & Partial<Pick<DiagramNode, 'kind' | 'flow' | 'calloutType'>>;

const DEFAULT_NODE_COLOURS: Partial<Record<DiagramKind, { fill: string; stroke: string }>> = {
  process: { fill: 'none', stroke: '#161616' }, document: { fill: 'none', stroke: '#161616' },
  terminator: { fill: '#edf5ff', stroke: '#0f62fe' }, decision: { fill: '#fcf4d6', stroke: '#b28600' },
  container: { fill: 'none', stroke: '#525252' },
};

export function diagramEditorNodeColours(node: ColouredNode): {
  fill: string; stroke: string; textColor: string;
} {
  const source = node.flow === undefined ? node.kind === undefined ? undefined : DEFAULT_NODE_COLOURS[node.kind] : STEP_STYLES[node.flow.stepType];
  const callout = node.kind === 'text' && node.calloutType !== undefined;
  const matches = source !== undefined && (node.fill.toLowerCase() === source.fill || node.fill.toLowerCase() === diagramEditorFill(source.fill))
    && diagramEditorInk(node.stroke) === source.stroke;
  const plainCard = (node.kind === 'process' || node.kind === 'document') && node.fill === '#ffffff' && node.stroke === '#161616';
  if (matches || plainCard || (callout && node.fill === 'none' && node.stroke === 'none')) {
    const gate = node.flow?.stepType === 'decision_gate';
    return {
      fill: node.kind === 'decision' ? gate ? '#fff1f1' : '#fffbeb' : node.kind === 'container' ? '#f7f4ff' : '#ffffff',
      stroke: node.kind === 'decision' ? gate ? '#fa4d56' : '#f1c21b' : node.kind === 'container' ? '#e8daff' : '#e0e0e0',
      textColor: diagramEditorInk(node.textColor),
    };
  }
  const fill = diagramEditorFill(node.fill);
  const darkAuthored = fill !== node.fill || fill === 'none' || fill === 'transparent';
  return { fill, stroke: darkAuthored ? diagramEditorInk(node.stroke) : node.stroke,
    textColor: darkAuthored ? diagramEditorInk(node.textColor) : node.textColor };
}

export function diagramNodeRadius(node: DiagramNode): number {
  if (node.collapsed === true) return 12;
  if (node.kind === 'terminator') return Math.min(node.height, node.width) / 2;
  if (node.kind === 'container') return 20;
  if (node.kind === 'process' || (node.kind === 'text' && node.calloutType !== undefined)) return 12;
  return node.kind === 'swimlane' ? 0 : node.kind === 'text' ? 2 : 4;
}

export function diagramNodeShadow(node: DiagramNode): boolean {
  const fill = diagramEditorNodeColours(node).fill;
  return fill !== 'none' && fill !== 'transparent' && (['process', 'decision', 'terminator', 'document'].includes(node.kind)
    || (node.kind === 'text' && node.calloutType !== undefined));
}

export const DIAGRAM_SHADOWS = [
  { dx: 0, dy: 2, stdDeviation: 3, floodColor: '#161616', floodOpacity: 0.08 },
  { dx: 0, dy: 0.5, stdDeviation: 0.5, floodColor: '#161616', floodOpacity: 0.1 },
] as const;

export function diagramNodeStrokeWidth(node: DiagramNode): number {
  return node.strokeWidth ?? (diagramNodeShadow(node) && node.kind !== 'decision' ? 1 : 1.5);
}

export function diagramEdgeAppearance(edge: DiagramEdge): { stroke: string; width: number; dash: string | undefined; label: string; labelBorder: string } {
  const defaults = edge.flow === undefined ? undefined : EDGE_STYLES[edge.flow.edgeType];
  const defaultStyle = defaults === undefined
    ? ['#525252', '#161616', '#8d8d8d'].includes(edge.stroke.toLowerCase()) && !edge.dashed
    : edge.stroke.toLowerCase() === defaults.stroke && edge.dashed === defaults.dashed;
  const branch = edge.label.trim().toLowerCase();
  const no = branch === 'no' || edge.flow?.gateOutcome === 'rework';
  const yes = branch === 'yes' || edge.flow?.gateOutcome === 'pass';
  const control = edge.flow?.edgeType === 'control';
  const sync = edge.flow?.interaction === 'sync';
  let stroke = edge.stroke;
  let dash = edge.dashed ? '4 4' : undefined;
  if (defaultStyle && (control || no || sync || edge.flow === undefined
    || edge.flow.interaction === 'async' || edge.flow.edgeType === 'primary_flow')) {
    stroke = control || no ? '#da1e28' : sync ? '#a8a8a8' : edge.flow === undefined ? '#8d8d8d' : '#6f6f6f';
    dash = control ? '5 4' : no || sync ? '4 4' : undefined;
  }
  return {
    stroke, dash, width: edge.strokeWidth ?? (defaultStyle && sync && !control && !no ? 1.25 : 1.5),
    label: no || control ? '#da1e28' : yes ? '#198038' : stroke === '#0f62fe' ? '#0043ce'
      : defaultStyle || stroke === 'none' ? '#525252' : stroke,
    labelBorder: no || control ? '#ffd7d9' : yes ? '#a7f0ba' : '#e0e0e0',
  };
}
