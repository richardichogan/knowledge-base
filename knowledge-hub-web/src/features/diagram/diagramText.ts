import type { DiagramNode } from './diagramTypes';
import { containerHeader, SWIMLANE_HEADER, documentWaveDepth, wrapText } from './diagramGeometry';

/** One label layout for the canvas and both export formats. */
export function diagramTextLayout(node: DiagramNode): {
  lines: string[]; x: number; y: number; anchor: 'start' | 'middle' | 'end'; weight: number; rotation?: string;
} {
  const { x, y, width: w, height: h, fontSize: fs } = node;
  const aligned = node.textAlign !== undefined || node.textVerticalAlign !== undefined;
  if (node.kind === 'container') {
    const header = containerHeader(node);
    const horizontal = node.textAlign ?? 'left';
    const textHeight = fs + Math.max(0, header.lines.length - 1) * fs * 1.25;
    const inset = Math.max(0, (header.height - textHeight) / 2);
    const cy = node.textVerticalAlign === 'top' ? y + Math.min(6, inset) + textHeight / 2
      : node.textVerticalAlign === 'bottom' ? y + header.height - Math.min(6, inset) - textHeight / 2
      : y + header.height / 2;
    return { lines: header.lines, x: horizontal === 'left' ? x + 10 : horizontal === 'right' ? x + w - 10 : x + w / 2,
      y: cy, anchor: horizontal === 'left' ? 'start' : horizontal === 'right' ? 'end' : 'middle', weight: 600 };
  }
  if (!aligned && node.kind === 'swimlane') {
    const bx = x + SWIMLANE_HEADER / 2;
    const cy = y + h / 2;
    return { lines: wrapText(node.label, h - 16, fs, 1), x: bx, y: cy, anchor: 'middle', weight: 600, rotation: `rotate(-90 ${bx} ${cy})` };
  }
  const width = node.kind === 'decision' ? w * 0.62 : node.kind === 'terminator' ? w - h * 0.6 : w - (node.kind === 'text' ? 8 : 16);
  const contentHeight = node.kind === 'document' ? h - 2 * documentWaveDepth(h) : h;
  const height = node.kind === 'decision' ? h * 0.6 : contentHeight - (node.kind === 'text' ? 0 : 8);
  const lines = wrapText(node.label, width, fs, Math.max(1, Math.floor(height / (fs * 1.25))));
  const horizontal = node.textAlign ?? 'center';
  const vertical = node.textVerticalAlign ?? 'middle';
  const halfText = ((lines.length - 1) * fs * 1.25 + fs) / 2;
  const insetX = (w - width) / 2;
  const insetY = (contentHeight - height) / 2;
  let cy = vertical === 'top' ? y + insetY + halfText : vertical === 'bottom' ? y + contentHeight - insetY - halfText : y + contentHeight / 2;
  if (!aligned && node.kind === 'image') cy = y + h - Math.round(fs * 1.3 + 10) / 2 - 2;
  return {
    lines: !aligned && node.kind === 'image' ? wrapText(node.label, w - 4, fs, 1) : lines,
    x: horizontal === 'left' ? x + insetX : horizontal === 'right' ? x + w - insetX : x + w / 2,
    y: cy, anchor: horizontal === 'left' ? 'start' : horizontal === 'right' ? 'end' : 'middle',
    weight: node.kind === 'swimlane' ? 600 : 400,
  };
}
