import type { DiagramNode } from './diagramTypes';
import { CONTAINER_HEADER, SWIMLANE_HEADER, documentWaveDepth, wrapText } from './diagramGeometry';

/** One label layout for the canvas and both export formats. */
export function diagramTextLayout(node: DiagramNode): {
  lines: string[]; x: number; y: number; anchor: 'start' | 'middle' | 'end'; weight: number; rotation?: string;
} {
  const { x, y, width: w, height: h, fontSize: fs } = node;
  const aligned = node.textAlign !== undefined || node.textVerticalAlign !== undefined;
  if (!aligned && node.kind === 'swimlane') {
    const bx = x + SWIMLANE_HEADER / 2;
    const cy = y + h / 2;
    return { lines: wrapText(node.label, h - 16, fs, 1), x: bx, y: cy, anchor: 'middle', weight: 600, rotation: `rotate(-90 ${bx} ${cy})` };
  }
  const width = node.kind === 'decision' ? w * 0.62 : node.kind === 'terminator' ? w - h * 0.6 : w - (node.kind === 'text' ? 8 : node.kind === 'container' ? 20 : 16);
  const contentHeight = node.kind === 'document' ? h - 2 * documentWaveDepth(h) : h;
  const height = node.kind === 'decision' ? h * 0.6 : contentHeight - (node.kind === 'text' ? 0 : 8);
  const lines = wrapText(node.label, width, fs, Math.max(1, Math.floor(height / (fs * 1.25))));
  const horizontal = node.textAlign ?? (node.kind === 'container' ? 'left' : 'center');
  const vertical = node.textVerticalAlign ?? 'middle';
  const halfText = ((lines.length - 1) * fs * 1.25 + fs) / 2;
  const insetX = (w - width) / 2;
  const insetY = (contentHeight - height) / 2;
  let cy = vertical === 'top' ? y + insetY + halfText : vertical === 'bottom' ? y + contentHeight - insetY - halfText : y + contentHeight / 2;
  if (!aligned && node.kind === 'container') cy = y + CONTAINER_HEADER / 2;
  if (!aligned && node.kind === 'image') cy = y + h - Math.round(fs * 1.3 + 10) / 2 - 2;
  return {
    lines: !aligned && (node.kind === 'container' || node.kind === 'image') ? wrapText(node.label, w - (node.kind === 'image' ? 4 : 20), fs, 1) : lines,
    x: horizontal === 'left' ? x + insetX : horizontal === 'right' ? x + w - insetX : x + w / 2,
    y: cy, anchor: horizontal === 'left' ? 'start' : horizontal === 'right' ? 'end' : 'middle',
    weight: node.kind === 'container' || node.kind === 'swimlane' ? 600 : 400,
  };
}
