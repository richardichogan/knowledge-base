import type { DiagramDocument, DiagramNode } from './diagramTypes';
import { collapseView, footnoteAnchor, footnoteText, footnotesOf, legendRows, elementInfo, FOOTNOTE_RADIUS } from './diagramAnnotations';
import { diagramTextLayout } from './diagramText';
import { diagramBorderDash } from './diagramStroke';
import { containerHeader, SWIMLANE_HEADER, diagramBounds, documentShapePath, edgeRoute, edgeLabelCenter, edgeLabelLayout, linePoints, nodeMap, renderOrder, wrapText } from './diagramGeometry';

const escapeXml = (text: string): string => text.replace(/[<>&"']/g, (c) => ({
  '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
}[c] ?? c));

function readDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => { reject(new Error('Could not embed an icon in the export')); };
    reader.onload = () => {
      if (typeof reader.result !== 'string') reject(new Error('Invalid image export data'));
      else resolve(reader.result);
    };
    reader.readAsDataURL(blob);
  });
}

function textLines(lines: string[], x: number, y: number, fontSize: number, colour: string, anchor = 'middle', weight = 400): string {
  const top = y - (lines.length - 1) * fontSize * 1.25 / 2;
  return `<text font-family="'IBM Plex Sans', system-ui, sans-serif" font-size="${fontSize}" fill="${escapeXml(colour)}" text-anchor="${anchor}" dominant-baseline="central" font-weight="${weight}">${lines.map((line, i) => `<tspan x="${x}" y="${top + i * fontSize * 1.25}">${escapeXml(line)}</tspan>`).join('')}</text>`;
}

function nodeText(node: DiagramNode): string {
  const layout = diagramTextLayout(node);
  const text = textLines(layout.lines, layout.x, layout.y, node.fontSize, node.textColor, layout.anchor, layout.weight);
  return layout.rotation ? `<g transform="${layout.rotation}">${text}</g>` : text;
}

export interface DiagramExportOptions {
  /** Numbered footnote markers plus the footnote text beneath the diagram (default true when footnotes exist). */
  footnotes?: boolean;
  /** The colour key beneath the diagram (default: when the key is shown in the editor). */
  legend?: boolean;
  /** Draw a placeholder instead of failing when an icon has not loaded (version previews). */
  tolerateMissingAssets?: boolean;
}

const FONT = `font-family="'IBM Plex Sans', system-ui, sans-serif"`;
const NOTE_FONT = 12;
const NOTE_LINE = NOTE_FONT * 1.35;

interface BuiltSvg { svg: string; width: number; height: number }

function marker(x: number, y: number, n: number): string {
  return `<g><circle cx="${x}" cy="${y}" r="${FOOTNOTE_RADIUS}" fill="#0f62fe" stroke="white" stroke-width="1.5"/><text x="${x}" y="${y}" ${FONT} font-size="11" font-weight="600" fill="white" text-anchor="middle" dominant-baseline="central">${n}</text></g>`;
}

async function buildSvg(source: DiagramDocument, assets: Map<string, Blob>, background: 'white' | 'transparent', includeGrid: boolean, options: DiagramExportOptions): Promise<BuiltSvg> {
  const view = collapseView(source);
  const document: DiagramDocument = { ...source, nodes: view.nodes, edges: view.edges };
  const byId = nodeMap(document.nodes);
  const bounds = diagramBounds(document);
  const fns = (options.footnotes ?? true) ? footnotesOf(source) : [];
  const rows = (options.legend ?? source.legend?.visible === true) ? legendRows(source).filter((r) => !r.hidden) : [];
  const ink = background === 'white' ? '#161616' : '#525252';
  // Annotation blocks sit below the diagram.
  const blockWidth = Math.max(420, Math.ceil(bounds.width));
  const extras: string[] = [];
  let cursor = bounds.y + bounds.height + 24;
  if (rows.length > 0) {
    extras.push(`<text x="${bounds.x}" y="${cursor}" ${FONT} font-size="13" font-weight="600" fill="${ink}" dominant-baseline="hanging">Key</text>`);
    cursor += 22;
    let x = bounds.x;
    for (const r of rows) {
      const text = r.label.trim() !== '' ? r.label.trim() : r.colour;
      const w = 28 + Math.min(260, text.length * 6.6) + 20;
      if (x > bounds.x && x + w > bounds.x + blockWidth) { x = bounds.x; cursor += 22; }
      extras.push(`<rect x="${x}" y="${cursor}" width="16" height="14" rx="2" fill="none" stroke="${escapeXml(r.colour)}" stroke-width="2.5"/><text x="${x + 24}" y="${cursor + 7}" ${FONT} font-size="${NOTE_FONT}" fill="${ink}" dominant-baseline="central">${escapeXml(text)}</text>`);
      x += w;
    }
    cursor += 30;
  }
  if (fns.length > 0) {
    extras.push(`<text x="${bounds.x}" y="${cursor}" ${FONT} font-size="13" font-weight="600" fill="${ink}" dominant-baseline="hanging">Notes</text>`);
    cursor += 24;
    fns.forEach((fn, i) => {
      const title = elementInfo(source, fn.targetId)?.label ?? '';
      const body = footnoteText(source, fn).trim();
      const lines = [
        ...wrapText(title, blockWidth - 36, NOTE_FONT, 2),
        ...body.split('\n').flatMap((para) => (para.trim() === '' ? [] : wrapText(para, blockWidth - 36, NOTE_FONT, 40))),
      ];
      extras.push(marker(bounds.x + FOOTNOTE_RADIUS, cursor + FOOTNOTE_RADIUS - 2, i + 1));
      extras.push(`<text ${FONT} font-size="${NOTE_FONT}" fill="${ink}">${lines.map((line, j) => `<tspan x="${bounds.x + 30}" y="${cursor + NOTE_FONT + j * NOTE_LINE}"${j === 0 ? ' font-weight="600"' : ''}>${escapeXml(line)}</tspan>`).join('')}</text>`);
      cursor += Math.max(FOOTNOTE_RADIUS * 2, lines.length * NOTE_LINE) + 12;
    });
  }
  const width = Math.max(1, Math.ceil(extras.length > 0 ? Math.max(bounds.width, blockWidth) : bounds.width));
  const height = Math.max(1, Math.ceil(extras.length > 0 ? cursor - bounds.y : bounds.height));
  const embedded = new Map<string, string>();
  for (const node of document.nodes) {
    if (node.assetId !== null && !embedded.has(node.assetId)) {
      const asset = assets.get(node.assetId);
      if (!asset) {
        if (options.tolerateMissingAssets === true) continue;
        throw new Error(`The icon for "${node.label || 'Image'}" has not loaded. Retry before exporting.`);
      }
      embedded.set(node.assetId, await readDataUrl(asset));
    }
  }
  const nodes = renderOrder(document.nodes).map((node) => {
    const strokeWidth = node.strokeWidth ?? 1.5;
    const dash = diagramBorderDash(node);
    const borderStyle = `${dash === undefined ? '' : ` stroke-dasharray="${dash}"`}${node.strokeStyle === 'dotted' ? ' stroke-linecap="round"' : ''}`;
    const colour = `fill="${escapeXml(node.fill)}" stroke="${escapeXml(node.stroke)}" stroke-width="${strokeWidth}"${borderStyle}`;
    let shape = '';
    if (node.kind === 'line') {
      const [start, end] = linePoints(node);
      shape = `<line x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}" fill="none" stroke="${escapeXml(node.stroke)}" stroke-width="${strokeWidth}"${borderStyle}/>`;
    } else if (node.kind === 'document') {
      shape = `<path d="${documentShapePath(node)}" ${colour}/>`;
    } else if (node.kind === 'decision') {
      shape = `<polygon points="${node.x + node.width / 2},${node.y} ${node.x + node.width},${node.y + node.height / 2} ${node.x + node.width / 2},${node.y + node.height} ${node.x},${node.y + node.height / 2}" ${colour}/>`;
    } else {
      const radius = node.kind === 'terminator' ? Math.min(node.width, node.height) / 2 : node.kind === 'process' ? 6 : node.kind === 'text' ? 2 : node.kind === 'swimlane' ? 0 : 4;
      shape = `<rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="${radius}" ${colour}/>`;
      if (node.kind === 'container') shape += `<line x1="${node.x}" x2="${node.x + node.width}" y1="${node.y + containerHeader(node).height}" y2="${node.y + containerHeader(node).height}" stroke="${escapeXml(node.stroke)}" stroke-width="${node.strokeWidth ?? 1}"${borderStyle}/>`;
      if (node.kind === 'swimlane') shape += `<rect x="${node.x}" y="${node.y}" width="${SWIMLANE_HEADER}" height="${node.height}" fill="${node.stroke === 'none' ? '#e0e0e0' : escapeXml(node.stroke)}" fill-opacity="0.1" stroke="${escapeXml(node.stroke)}" stroke-width="${strokeWidth}"${borderStyle}/>`;
    }
    if (node.assetId !== null && embedded.has(node.assetId)) {
      const captionHeight = node.label.trim() ? Math.round(node.fontSize * 1.3 + 10) : 0;
      shape += `<image x="${node.x + 4}" y="${node.y + 4}" width="${Math.max(1, node.width - 8)}" height="${Math.max(1, node.height - captionHeight - 8)}" preserveAspectRatio="xMidYMid meet" href="${escapeXml(embedded.get(node.assetId) ?? '')}"/>`;
    }
    if (view.hiddenCount.has(node.id)) {
      const header = Math.min(node.height, node.kind === 'swimlane' ? node.height : containerHeader(node).height);
      shape += `<text x="${node.x + node.width - 10}" y="${node.y + header / 2}" ${FONT} font-size="11" fill="${escapeXml(node.textColor)}" text-anchor="end" dominant-baseline="central">+${view.hiddenCount.get(node.id)}</text>`;
    }
    return `<g>${shape}${node.kind === 'line' ? '' : nodeText(node)}</g>`;
  });
  const definitions: string[] = [];
  const edges = document.edges.map((edge, i) => {
    const points = edgeRoute(edge, byId) ?? [];
    if (points.length < 2) throw new Error(`Connector "${edge.label}" is not attached to two shapes`);
    definitions.push(`<marker id="arrow-${i}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="${20 / 3}" markerHeight="${20 / 3}" markerUnits="strokeWidth" orient="auto-start-reverse"><path d="M0,1 L10,5 L0,9 z" fill="${escapeXml(edge.stroke)}"/></marker>`);
    const middle = edgeLabelCenter(points, edge);
    const path = `<polyline points="${points.map((p) => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="${escapeXml(edge.stroke)}" stroke-width="${edge.strokeWidth ?? 1.5}"${edge.dashed ? ' stroke-dasharray="6 4"' : ''}${edge.arrows !== 'none' ? ` marker-end="url(#arrow-${i})"` : ''}${edge.arrows === 'both' ? ` marker-start="url(#arrow-${i})"` : ''}/>`;
    const { lines, width: labelW, height: labelH, fontSize, lineHeight } = edgeLabelLayout(edge);
    const label = edge.label.trim() ? `<rect x="${middle.x - labelW / 2}" y="${middle.y - labelH / 2}" width="${labelW}" height="${labelH}" rx="3" fill="white" fill-opacity="0.92"/><text x="${middle.x}" y="${middle.y - labelH / 2 + 3 + fontSize}" font-family="'IBM Plex Sans', system-ui, sans-serif" font-size="${fontSize}" text-anchor="middle" fill="${edge.stroke === 'none' ? '#161616' : escapeXml(edge.stroke)}">${lines.map((line, j) => `<tspan x="${middle.x}" dy="${j === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`).join('')}</text>` : '';
    return `${path}${label}`;
  });
  const markers = fns.flatMap((fn, i) => {
    const target = view.hiddenBy.get(fn.targetId) ?? fn.targetId;
    const at = footnoteAnchor(document, target, byId);
    return at === null ? [] : [marker(at.x, at.y, i + 1)];
  });
  const grid = includeGrid ? `<pattern id="export-grid" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="0" cy="0" r="1" fill="#d0d0d0"/></pattern>` : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${bounds.x} ${bounds.y} ${width} ${height}"><defs>${grid}${definitions.join('')}</defs>${background === 'white' ? `<rect x="${bounds.x}" y="${bounds.y}" width="${width}" height="${height}" fill="white"/>` : ''}${includeGrid ? `<rect x="${bounds.x}" y="${bounds.y}" width="${width}" height="${height}" fill="url(#export-grid)"/>` : ''}${nodes.join('')}${edges.join('')}${markers.join('')}${extras.join('')}</svg>`;
  return { svg, width, height };
}

export async function diagramSvg(document: DiagramDocument, assets: Map<string, Blob>, background: 'white' | 'transparent', includeGrid = false, options: DiagramExportOptions = {}): Promise<string> {
  return (await buildSvg(document, assets, background, includeGrid, options)).svg;
}

export async function exportDiagram(document: DiagramDocument, assets: Map<string, Blob>, format: 'png' | 'svg', background: 'white' | 'transparent', includeGrid = false, options: DiagramExportOptions = {}): Promise<void> {
  const { svg, width, height } = await buildSvg(document, assets, background, includeGrid, options);
  let blob = new Blob([svg], { type: 'image/svg+xml' });
  if (format === 'png') {
    if (width > 16384 || height > 16384 || width * height > 64_000_000) {
      throw new Error('This diagram exceeds the PNG limit (16,384 pixels per side or 64 megapixels). Export SVG instead.');
    }
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => { resolve(); };
        image.onerror = () => { reject(new Error('Could not render the diagram image. Try SVG export.')); };
        image.src = url;
      });
      const canvas = window.document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('The browser could not create an image export surface');
      context.drawImage(image, 0, 0);
      blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((result) => { if (result) resolve(result); else reject(new Error('PNG encoding failed. Try SVG export.')); }, 'image/png');
      });
    } finally { URL.revokeObjectURL(url); }
  }
  const download = URL.createObjectURL(blob);
  const link = window.document.createElement('a');
  link.href = download; link.download = `diagram.${format}`;
  window.document.body.append(link);
  link.click(); link.remove();
  // Keep the URL alive until the browser has started the download.
  window.setTimeout(() => { URL.revokeObjectURL(download); }, 30_000);
}
