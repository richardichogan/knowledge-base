/**
 * features/canvas/canvasExport.ts — brainstorm exports.
 *   - canvasExportBlob: PNG or SVG drawn as on screen (cards, icon tiles, elbow connectors)
 *   - canvasDiagramDocument: the cards as diagram shapes, for the Mural export
 */
import { createElement } from 'react';
import type { CanvasFullApi, CanvasNodeApi } from '../../services/api';
import type { DiagramDocument, DiagramPort } from '../diagram/diagramTypes';
import { elbowPath, linkStyle, DEFAULT_LINK_TYPE, cardTree, hiddenCards, type Point, type Size } from './canvasGraph';
import { cardIcon, cardKindLabel, ideaCardType, hasFootnote } from './mapVisuals';

export type CanvasExportFormat = 'png' | 'svg';

const SANS = "'IBM Plex Sans', system-ui, sans-serif";
const MONO = "'IBM Plex Mono', monospace";
const MARGIN = 40;
const ARROW_SIZE = 8;
const MAX_PNG_SIDE = 16384;
const MAX_PNG_PIXELS = 64_000_000;

/** On-screen card colours (global.scss `.cv-card--*`): tile tint, icon and kind-label ink. */
const CARD_COLOURS: Record<string, { tint: string; icon: string; ink: string }> = {
  idea: { tint: '#fcf4d6', icon: '#b28600', ink: '#8e6a00' },
  note: { tint: '#d9fbfb', icon: '#007d79', ink: '#005d5d' },
  content_item: { tint: '#edf5ff', icon: '#0f62fe', ink: '#0043ce' },
  spark: { tint: '#fff2e8', icon: '#eb6200', ink: '#8a3800' },
  discover_item: { tint: '#e5f6ff', icon: '#0072c3', ink: '#00539a' },
  ai_session: { tint: '#f6f2ff', icon: '#8a3ffc', ink: '#6929c4' },
};
const ROOT_COLOURS = { tint: '#d9fbfb', icon: '#007d79', ink: '#005d5d' };
const NOTES_GAP = 48;
const NOTES_MIN_WIDTH = 320;

function coloursOf(card: Card): { tint: string; icon: string; ink: string } {
  const type = ideaCardType(card.node, card.root);
  if (type !== null) return { tint: type.tint, icon: type.colour, ink: type.ink };
  return card.root ? ROOT_COLOURS : CARD_COLOURS[card.node.refType ?? 'idea'] ?? CARD_COLOURS['idea']!;
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

let measureCtx: CanvasRenderingContext2D | null = null;
function textWidth(text: string, font: string): number {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  if (measureCtx === null) return text.length * 7;
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

/** Word-wraps text to a width, ending the last allowed line with an ellipsis if it overflows. */
function wrap(text: string, font: string, width: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = '';
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? '';
    const next = line === '' ? word : `${line} ${word}`;
    if (textWidth(next, font) <= width || line === '') { line = next; continue; }
    lines.push(line);
    line = word;
    if (lines.length === maxLines) { line = ''; break; }
  }
  if (line !== '') lines.push(line);
  const overflow = lines.length > maxLines || (lines.length === maxLines && lines.join(' ').length < text.replace(/\s+/g, ' ').trim().length);
  const kept = lines.slice(0, maxLines);
  if (overflow && kept.length > 0) {
    let last = kept[kept.length - 1] ?? '';
    while (last.length > 0 && textWidth(`${last}…`, font) > width) last = last.slice(0, -1);
    kept[kept.length - 1] = `${last.trimEnd()}…`;
  }
  return kept;
}

function textBlock(lines: string[], x: number, top: number, size: number, lineHeight: number, attrs: string): string {
  return lines.map((l, i) => `<text x="${x}" y="${top + i * lineHeight + lineHeight / 2 + size * 0.35}" font-size="${size}" ${attrs}>${esc(l)}</text>`).join('');
}

interface Card { node: CanvasNodeApi; at: Point; size: Size; root: boolean; pinned: boolean; footnote: number | undefined }

/** Visible cards only: cards under a collapsed card are left out, as on screen. */
function cards(map: CanvasFullApi, sizeOf: (n: CanvasNodeApi) => Size): Card[] {
  const pinnedIds = new Set(map.linkedNotes.map((n) => n.id));
  const root = map.nodes[0];
  const hidden = root !== undefined ? hiddenCards(map.nodes, cardTree(map.nodes, map.edges, root.id)) : new Set<string>();
  let footnotes = 0;
  return map.nodes.flatMap((node, i) => {
    const footnote = hasFootnote(node) ? ++footnotes : undefined;
    if (hidden.has(node.id)) return [];
    return [{
      node, at: { x: node.x, y: node.y }, size: sizeOf(node), root: i === 0, footnote,
      pinned: node.refType === 'note' && node.refId !== null && pinnedIds.has(node.refId),
    }];
  });
}

async function cardSvg(card: Card): Promise<string> {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { node, at, size, root, pinned } = card;
  const colours = coloursOf(card);
  const left = at.x - size.w / 2;
  const top = at.y - size.h / 2;
  const thick = root || pinned;
  const border = thick ? 2 : 1;
  const shape = `<rect x="${left + border / 2}" y="${top + border / 2}" width="${size.w - border}" height="${size.h - border}" rx="4" fill="${root ? '#f2fcfc' : '#ffffff'}" stroke="${thick ? '#007d79' : '#c6c6c6'}" stroke-width="${border}" filter="url(#cv-shadow)"/>`;
  const icon = (px: number, colour: string, x: number, y: number): string =>
    `<g transform="translate(${x} ${y})" color="${colour}">${renderToStaticMarkup(createElement(cardIcon(node, root), { size: px }))}</g>`;

  const padX = root ? 16 : 12;
  const padTop = root ? 14 : 12;
  let parts = '';
  let bodyX = left + padX;
  if (!root) {
    parts += `<rect x="${left + padX}" y="${top + padTop}" width="26" height="26" rx="2" fill="${colours.tint}"/>`;
    parts += icon(16, colours.icon, left + padX + 5, top + padTop + 5);
    bodyX = left + padX + 26 + 10;
  }
  const bodyW = left + size.w - padX - bodyX;
  let y = top + padTop;
  const kindH = 9.5 * 1.2;
  let kindX = bodyX;
  if (root) { parts += icon(14, colours.icon, bodyX, y + kindH / 2 - 7); kindX += 14 + 6; }
  parts += textBlock([cardKindLabel(node, root).toUpperCase()], kindX, y, 9.5, kindH, `font-family="${MONO}" letter-spacing="0.76" fill="${colours.ink}"`);
  y += kindH + 4.8;

  const titleSize = root ? 16 : 13.5;
  const titleLh = root ? 20 : 13.5 * 1.3;
  const title = node.label !== null && node.label.trim() !== '' ? node.label : 'Untitled';
  const titleLines = wrap(title, `600 ${titleSize}px ${SANS}`, bodyW, 3);
  parts += textBlock(titleLines, bodyX, y, titleSize, titleLh, `font-family="${SANS}" font-weight="600" fill="${title === node.label ? '#161616' : '#8d8d8d'}"`);
  y += titleLines.length * titleLh;

  if (node.body !== null && node.body.trim() !== '') {
    y += 4.8;
    const noteLines = wrap(node.body, `italic 12px ${SANS}`, bodyW, 2);
    parts += textBlock(noteLines, bodyX, y, 12, 12 * 1.35, `font-family="${SANS}" font-style="italic" fill="#525252"`);
  }
  if (card.footnote !== undefined) parts += footnoteMarker(card.footnote, left + size.w, top, 10);
  return `<g>${shape}${parts}</g>`;
}

function footnoteMarker(n: number, cx: number, cy: number, r: number): string {
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#0f62fe" stroke="#ffffff" stroke-width="1.5"/><text x="${cx}" y="${cy + r * 0.38}" font-family="${SANS}" font-size="${r * 1.1}" font-weight="600" text-anchor="middle" fill="#ffffff">${n}</text>`;
}

/** Footnotes listed beneath the cards, like the on-screen Notes block. */
function notesBlock(all: Card[], left: number, top: number, width: number): { svg: string; height: number } {
  const noted = all.filter((c) => c.footnote !== undefined).sort((a, b) => (a.footnote ?? 0) - (b.footnote ?? 0));
  if (noted.length === 0) return { svg: '', height: 0 };
  let svg = `<line x1="${left}" y1="${top}" x2="${left + width}" y2="${top}" stroke="#8d8d8d" stroke-opacity="0.65" stroke-dasharray="6 6"/>`;
  let y = top + 16;
  svg += textBlock(['Notes'], left, y, 14, 18, `font-family="${SANS}" font-weight="600" fill="#161616"`);
  y += 18 + 8;
  for (const c of noted) {
    const title = c.node.label !== null && c.node.label.trim() !== '' ? c.node.label : 'Untitled';
    const lines = wrap(`${title}: ${c.node.footnote ?? ''}`, `12px ${SANS}`, width - 26, 6);
    svg += footnoteMarker(c.footnote ?? 0, left + 9, y + 9, 9);
    svg += textBlock(lines, left + 26, y, 12, 18, `font-family="${SANS}" fill="#161616"`);
    y += lines.length * 18 + 4;
  }
  return { svg, height: y - top };
}

/** The brainstorm as an SVG, drawn as on screen. */
export async function canvasSvg(map: CanvasFullApi, sizeOf: (n: CanvasNodeApi) => Size, background: 'white' | 'transparent'): Promise<{ svg: string; width: number; height: number }> {
  const all = cards(map, sizeOf);
  const byId = new Map(all.map((c) => [c.node.id, c]));
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const c of all) {
    minX = Math.min(minX, c.at.x - c.size.w / 2); maxX = Math.max(maxX, c.at.x + c.size.w / 2);
    minY = Math.min(minY, c.at.y - c.size.h / 2); maxY = Math.max(maxY, c.at.y + c.size.h / 2);
  }
  if (all.length === 0) { minX = 0; minY = 0; maxX = 0; maxY = 0; }
  const cardsRight = maxX;
  const notes = notesBlock(all, minX, maxY + NOTES_GAP, Math.max(cardsRight - minX, NOTES_MIN_WIDTH));
  if (notes.height > 0) { maxY += NOTES_GAP + notes.height; maxX = Math.max(maxX, minX + NOTES_MIN_WIDTH); }
  if (all.some((c) => c.footnote !== undefined)) { minY -= 10; maxX += 10; }
  const x0 = Math.floor(minX - MARGIN);
  const y0 = Math.floor(minY - MARGIN);
  const width = Math.ceil(maxX + MARGIN) - x0;
  const height = Math.ceil(maxY + MARGIN) - y0;

  const markers = new Set<string>();
  const lines: string[] = [];
  const labels: string[] = [];
  for (const e of map.edges) {
    const a = byId.get(e.sourceId);
    const b = byId.get(e.targetId);
    if (a === undefined || b === undefined) continue;
    const style = linkStyle(e.type);
    const { d, mid } = elbowPath(a.at, a.size, b.at, b.size, style.directed ? ARROW_SIZE : 0);
    const markerName = `cv-arrow-${style.sheet.slice(1)}`;
    if (style.directed) markers.add(style.sheet);
    lines.push(`<path d="${d}" fill="none" stroke="${style.sheet}" stroke-width="${e.type === DEFAULT_LINK_TYPE ? 1.25 : 1.75}"${style.dashed ? ' stroke-dasharray="6 5"' : ''}${style.directed ? ` marker-end="url(#${markerName})"` : ''}/>`);
    const typed = e.type !== DEFAULT_LINK_TYPE;
    if (!typed && e.label === null) continue;
    const text = `${typed ? e.type : ''}${typed && e.label !== null ? ' · ' : ''}${e.label ?? ''}`;
    if (text === '') continue;
    const w = textWidth(text, `600 10.5px ${SANS}`) + 18;
    labels.push(`<rect x="${mid.x - w / 2}" y="${mid.y - 9}" width="${w}" height="18" rx="9" fill="#ffffff" stroke="${style.sheet}"/><text x="${mid.x}" y="${mid.y + 3.7}" font-family="${SANS}" font-size="10.5" font-weight="600" text-anchor="middle" fill="${style.sheet}">${esc(text)}</text>`);
  }
  const markerDefs = [...markers].map((c) => `<marker id="cv-arrow-${c.slice(1)}" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="${ARROW_SIZE}" markerHeight="${ARROW_SIZE}" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${c}"/></marker>`).join('');
  const shadow = '<filter id="cv-shadow" x="-10%" y="-20%" width="120%" height="150%"><feDropShadow dx="0" dy="2" stdDeviation="1.5" flood-color="#161616" flood-opacity="0.08"/></filter>';
  const cardSvgs = await Promise.all(all.map(cardSvg));
  const bg = background === 'white' ? `<rect x="${x0}" y="${y0}" width="${width}" height="${height}" fill="#ffffff"/>` : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${x0} ${y0} ${width} ${height}"><defs>${markerDefs}${shadow}</defs>${bg}${lines.join('')}${labels.join('')}${cardSvgs.join('')}${notes.svg}</svg>`;
  return { svg, width, height };
}

export async function canvasExportBlob(map: CanvasFullApi, sizeOf: (n: CanvasNodeApi) => Size, format: CanvasExportFormat, background: 'white' | 'transparent'): Promise<Blob> {
  const { svg, width, height } = await canvasSvg(map, sizeOf, background);
  const svgBlob = new Blob([svg], { type: 'image/svg+xml' });
  if (format === 'svg') return svgBlob;
  const scale = 2;
  if (width * scale > MAX_PNG_SIDE || height * scale > MAX_PNG_SIDE || width * height * scale * scale > MAX_PNG_PIXELS) {
    throw new Error('This brainstorm is too large for a PNG. Export SVG instead.');
  }
  const url = URL.createObjectURL(svgBlob);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => { resolve(); };
      image.onerror = () => { reject(new Error('Could not render the brainstorm image. Try SVG export.')); };
      image.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = width * scale; canvas.height = height * scale;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('The browser could not create an image export surface.');
    context.scale(scale, scale);
    context.drawImage(image, 0, 0, width, height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => { if (b !== null) resolve(b); else reject(new Error('PNG encoding failed. Try SVG export.')); }, 'image/png');
    });
  } finally { URL.revokeObjectURL(url); }
}

/** Facing sides of two cards, matching how elbowPath joins them on screen. */
function ports(a: Card, b: Card): [DiagramPort, DiagramPort] {
  if (Math.abs(b.at.x - a.at.x) >= (a.size.w + b.size.w) / 2) return b.at.x > a.at.x ? ['right', 'left'] : ['left', 'right'];
  return b.at.y > a.at.y ? ['bottom', 'top'] : ['top', 'bottom'];
}

/** The brainstorm as diagram shapes and connectors, so the existing Mural export can send it. */
export function canvasDiagramDocument(map: CanvasFullApi, sizeOf: (n: CanvasNodeApi) => Size): DiagramDocument {
  const all = cards(map, sizeOf);
  const byId = new Map(all.map((c) => [c.node.id, c]));
  return {
    version: 1,
    grid: false,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: all.map((c) => {
      const colours = coloursOf(c);
      const title = c.node.label !== null && c.node.label.trim() !== '' ? c.node.label : 'Untitled';
      return {
        id: c.node.id, kind: 'process' as const, label: title,
        ...(c.node.body !== null && c.node.body.trim() !== '' && { description: c.node.body }),
        x: Math.round(c.at.x - c.size.w / 2), y: Math.round(c.at.y - c.size.h / 2), width: Math.round(c.size.w), height: Math.round(c.size.h),
        parentId: null, fill: c.root ? '#f2fcfc' : '#ffffff', stroke: c.root || c.pinned ? '#007d79' : colours.icon,
        strokeWidth: c.root ? 2 : 1.5, textColor: '#161616', fontSize: c.root ? 16 : 13, assetId: null,
      };
    }),
    edges: map.edges.flatMap((e) => {
      const a = byId.get(e.sourceId);
      const b = byId.get(e.targetId);
      if (a === undefined || b === undefined) return [];
      const style = linkStyle(e.type);
      const [sourcePort, targetPort] = ports(a, b);
      const typed = e.type !== DEFAULT_LINK_TYPE;
      return [{
        id: e.id, sourceId: e.sourceId, targetId: e.targetId, sourcePort, targetPort, route: 'orthogonal' as const, waypoints: [],
        label: `${typed ? e.type : ''}${typed && e.label !== null ? ' · ' : ''}${e.label ?? ''}`,
        stroke: style.sheet, strokeWidth: typed ? 1.75 : 1.25, dashed: style.dashed, arrows: style.directed ? 'end' as const : 'none' as const,
      }];
    }),
  };
}
