import type { DiagramDocument, DiagramNode } from './diagramTypes';
import { CONTAINER_HEADER, SWIMLANE_HEADER, diagramBounds, edgePoints, pointAlong, renderOrder, wrapText } from './diagramGeometry';

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
  const { x, y, width: w, height: h, fontSize: fs, textColor } = node;
  const cx = x + w / 2; const cy = y + h / 2;
  if (node.kind === 'container') return textLines(wrapText(node.label, w - 20, fs, 1), x + 10, y + CONTAINER_HEADER / 2, fs, textColor, 'start', 600);
  if (node.kind === 'swimlane') {
    const bandX = x + SWIMLANE_HEADER / 2;
    return `<g transform="rotate(-90 ${bandX} ${cy})">${textLines(wrapText(node.label, h - 16, fs, 1), bandX, cy, fs, textColor, 'middle', 600)}</g>`;
  }
  if (node.kind === 'image') return node.label.trim() === '' ? '' : textLines(wrapText(node.label, w - 4, fs, 1), cx, y + h - Math.round(fs * 1.3 + 10) / 2 - 2, fs, textColor);
  const width = node.kind === 'decision' ? w * 0.62 : node.kind === 'terminator' ? w - h * 0.6 : w - (node.kind === 'text' ? 8 : 16);
  const height = node.kind === 'decision' ? h * 0.6 : h - (node.kind === 'text' ? 0 : 8);
  return textLines(wrapText(node.label, width, fs, Math.max(1, Math.floor(height / (fs * 1.25)))), cx, cy, fs, textColor);
}

export async function diagramSvg(document: DiagramDocument, assets: Map<string, Blob>, background: 'white' | 'transparent', includeGrid = false): Promise<string> {
  const bounds = diagramBounds(document);
  const width = Math.max(1, Math.ceil(bounds.width));
  const height = Math.max(1, Math.ceil(bounds.height));
  const embedded = new Map<string, string>();
  for (const node of document.nodes) {
    if (node.assetId !== null && !embedded.has(node.assetId)) {
      const asset = assets.get(node.assetId);
      if (!asset) throw new Error(`The icon for "${node.label || 'Image'}" has not loaded. Retry before exporting.`);
      embedded.set(node.assetId, await readDataUrl(asset));
    }
  }
  const nodes = renderOrder(document.nodes).map((node) => {
    const colour = `fill="${escapeXml(node.fill)}" stroke="${escapeXml(node.stroke)}" stroke-width="1.5"`;
    let shape = '';
    if (node.kind === 'decision') {
      shape = `<polygon points="${node.x + node.width / 2},${node.y} ${node.x + node.width},${node.y + node.height / 2} ${node.x + node.width / 2},${node.y + node.height} ${node.x},${node.y + node.height / 2}" ${colour}/>`;
    } else {
      const radius = node.kind === 'terminator' ? Math.min(node.width, node.height) / 2 : node.kind === 'process' ? 6 : node.kind === 'text' ? 2 : node.kind === 'swimlane' ? 0 : 4;
      shape = `<rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="${radius}" ${colour}/>`;
      if (node.kind === 'container') shape += `<line x1="${node.x}" x2="${node.x + node.width}" y1="${node.y + CONTAINER_HEADER}" y2="${node.y + CONTAINER_HEADER}" stroke="${escapeXml(node.stroke)}"/>`;
      if (node.kind === 'swimlane') shape += `<rect x="${node.x}" y="${node.y}" width="${SWIMLANE_HEADER}" height="${node.height}" fill="${node.stroke === 'none' ? '#e0e0e0' : escapeXml(node.stroke)}" fill-opacity="0.1" stroke="${escapeXml(node.stroke)}" stroke-width="1.5"/>`;
    }
    if (node.assetId !== null) {
      const captionHeight = node.label.trim() ? Math.round(node.fontSize * 1.3 + 10) : 0;
      shape += `<image x="${node.x + 4}" y="${node.y + 4}" width="${Math.max(1, node.width - 8)}" height="${Math.max(1, node.height - captionHeight - 8)}" preserveAspectRatio="xMidYMid meet" href="${escapeXml(embedded.get(node.assetId) ?? '')}"/>`;
    }
    return `<g>${shape}${nodeText(node)}</g>`;
  });
  const definitions: string[] = [];
  const edges = document.edges.map((edge, i) => {
    const points = edgePoints(edge, document.nodes);
    if (points.length < 2) throw new Error(`Connector "${edge.label}" is not attached to two shapes`);
    definitions.push(`<marker id="arrow-${i}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0,1 L10,5 L0,9 z" fill="${escapeXml(edge.stroke)}"/></marker>`);
    const middle = pointAlong(points, 0.5);
    const path = `<polyline points="${points.map((p) => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="${escapeXml(edge.stroke)}" stroke-width="1.5"${edge.dashed ? ' stroke-dasharray="6 4"' : ''}${edge.arrows !== 'none' ? ` marker-end="url(#arrow-${i})"` : ''}${edge.arrows === 'both' ? ` marker-start="url(#arrow-${i})"` : ''}/>`;
    const lines = wrapText(edge.label, 160, 12, 3);
    const labelW = Math.max(...lines.map((line) => line.length), 0) * 12 * 0.56 + 12;
    const labelH = lines.length * 15 + 6;
    const label = edge.label.trim() ? `<rect x="${middle.x - labelW / 2}" y="${middle.y - labelH / 2}" width="${labelW}" height="${labelH}" rx="3" fill="white" fill-opacity="0.92"/><text x="${middle.x}" y="${middle.y - labelH / 2 + 15}" font-family="'IBM Plex Sans', system-ui, sans-serif" font-size="12" text-anchor="middle" fill="${edge.stroke === 'none' ? '#161616' : escapeXml(edge.stroke)}">${lines.map((line, j) => `<tspan x="${middle.x}" dy="${j === 0 ? 0 : 15}">${escapeXml(line)}</tspan>`).join('')}</text>` : '';
    return `${path}${label}`;
  });
  const grid = includeGrid ? `<pattern id="export-grid" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="0" cy="0" r="1" fill="#d0d0d0"/></pattern>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${bounds.x} ${bounds.y} ${width} ${height}"><defs>${grid}${definitions.join('')}</defs>${background === 'white' ? `<rect x="${bounds.x}" y="${bounds.y}" width="${width}" height="${height}" fill="white"/>` : ''}${includeGrid ? `<rect x="${bounds.x}" y="${bounds.y}" width="${width}" height="${height}" fill="url(#export-grid)"/>` : ''}${nodes.join('')}${edges.join('')}</svg>`;
}

export async function exportDiagram(document: DiagramDocument, assets: Map<string, Blob>, format: 'png' | 'svg', background: 'white' | 'transparent', includeGrid = false): Promise<void> {
  const svg = await diagramSvg(document, assets, background, includeGrid);
  let blob = new Blob([svg], { type: 'image/svg+xml' });
  if (format === 'png') {
    const bounds = diagramBounds(document);
    const width = Math.ceil(bounds.width);
    const height = Math.ceil(bounds.height);
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
