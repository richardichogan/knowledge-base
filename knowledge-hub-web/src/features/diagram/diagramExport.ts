import type { DiagramDocument, DiagramNode } from './diagramTypes';
import { createElement } from 'react';
import { DiagramRoleBadge, diagramRoleLayout, type DiagramRoleLayout } from './DiagramRoleBadge';
import { diagramEditorNodeColours, diagramEdgeAppearance, diagramNodeRadius, diagramNodeShadow, diagramNodeStrokeWidth, DIAGRAM_SHADOWS } from './diagramTheme';
import { collapseView, footnoteAnchor, footnoteBlock, footnotesOf, keyLayout, legendRows, FOOTNOTE_RADIUS, NOTE_FONT, NOTE_HEADING_FONT } from './diagramAnnotations';
import { diagramTextLayout } from './diagramText';
import { descriptionPlainText, styledLines } from './diagramMarkdown';
import { calloutLayout } from './diagramCallouts';
import { diagramDrawioXml } from './diagramDrawio';
import { diagramBorderDash } from './diagramStroke';
import { diagramLineJumpGeometry } from './diagramLineJumps';
import { arrowShapePath, boundsOf, containerHeader, SWIMLANE_HEADER, diagramBounds, documentShapePath, decisionShapePath, hexagonShapePath, roundedRoutePath, edgeRoute, edgeLabelCenter, edgeLabelLayout, linePoints, nodeMap, renderOrder, type Rect } from './diagramGeometry';
import { checkAiFlow } from './aiFlow';
import {
  AI_CHIP_COLOURS, AI_CHIP_FONT, AI_FINDING_RADIUS, AI_SEVERITY_COLOURS, aiEdgeChip, aiEdgeFindingAnchor, aiFindingAnchor, aiLaneOwnerLayout,
  aiStepChips, findingsByTarget, isAiFlowDoc, type AiChip, type AiTargetFindings,
} from './diagramAiFlowBadges';

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

/** One line of title text, with its **bold** and *italic* runs when the Markdown source is given. */
function lineSvg(source: string | undefined, lines: string[]): string[] {
  if (source === undefined) return lines.map(escapeXml);
  return styledLines(source, lines).map((runs) => runs.map((run) => run.bold || run.italic
    ? `<tspan${run.bold ? ' font-weight="700"' : ''}${run.italic ? ' font-style="italic"' : ''}>${escapeXml(run.text)}</tspan>`
    : escapeXml(run.text)).join(''));
}

function textLines(lines: string[], x: number, y: number, fontSize: number, colour: string, anchor = 'middle', weight = 400, source?: string): string {
  const top = y - (lines.length - 1) * fontSize * 1.25 / 2;
  const content = lineSvg(source, lines);
  return `<text font-family="'IBM Plex Sans', system-ui, sans-serif" font-size="${fontSize}" fill="${escapeXml(colour)}" text-anchor="${anchor}" dominant-baseline="central" font-weight="${weight}">${content.map((line, i) => `<tspan x="${x}" y="${top + i * fontSize * 1.25}">${line}</tspan>`).join('')}</text>`;
}

function nodeText(node: DiagramNode, titleShift = 0, role?: DiagramRoleLayout | null): string {
  const layout = diagramTextLayout(node, role);
  const text = textLines(layout.lines, layout.x, layout.y, node.fontSize, node.textColor, layout.anchor, layout.weight, node.label);
  const rotated = layout.rotation ? `<g transform="${layout.rotation}">${text}</g>` : text;
  return titleShift !== 0 && layout.rotation ? `<g transform="translate(${titleShift} 0)">${rotated}</g>` : rotated;
}

function chipSvg(chip: AiChip): string {
  const c = AI_CHIP_COLOURS[chip.tone];
  return `<g data-ai-chip="${chip.key}"><title>${escapeXml(chip.title)}</title><rect x="${chip.x}" y="${chip.y}" width="${chip.width}" height="${chip.height}" rx="${chip.height / 2}" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1"${c.dashed === true ? ' stroke-dasharray="3 2"' : ''}/><text x="${chip.x + chip.width / 2}" y="${chip.y + chip.height / 2}" ${FONT} font-size="${AI_CHIP_FONT}" font-weight="600" fill="${c.text}" text-anchor="middle" dominant-baseline="central">${escapeXml(chip.text)}</text></g>`;
}

function findingSvg(at: { x: number; y: number }, target: AiTargetFindings): string {
  const c = AI_SEVERITY_COLOURS[target.severity];
  return `<g data-ai-finding="${target.severity}"><title>${escapeXml(target.findings.map((f) => f.message).join('\n'))}</title><circle cx="${at.x}" cy="${at.y}" r="${AI_FINDING_RADIUS}" fill="${c.fill}" stroke="#ffffff" stroke-width="2"/><text x="${at.x}" y="${at.y}" ${FONT} font-size="10" font-weight="700" fill="${c.text}" text-anchor="middle" dominant-baseline="central">${target.severity === 'info' ? 'i' : '!'}</text></g>`;
}

function calloutHeader(node: DiagramNode): string {
  const callout = calloutLayout(node);
  if (callout === null) return '';
  return `<g data-callout-type="${callout.type}"><title>${callout.label} callout</title><rect x="${callout.icon.x - 4}" y="${callout.icon.y - 4}" width="${callout.icon.size + 8}" height="${callout.icon.size + 8}" rx="7" fill="#fcf4d6"/><path d="${callout.path}" fill="none" stroke="#8e6a00" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" transform="translate(${callout.icon.x} ${callout.icon.y}) scale(${callout.icon.size / 20})"/><text x="${callout.text.x}" y="${callout.text.y}" font-family="'IBM Plex Sans', system-ui, sans-serif" font-size="${callout.text.fontSize}" fill="${escapeXml(node.textColor)}" font-weight="600" dominant-baseline="central">${callout.label}</text></g>`;
}

export interface DiagramExportOptions {
  /** Numbered footnote markers plus the notes block beside or beneath the diagram (default true when footnotes exist). */
  footnotes?: boolean;
  /** The colour key beneath the diagram (default: when the key is shown in the editor). */
  legend?: boolean;
  /** Draw a placeholder instead of failing when an icon has not loaded (version previews). */
  tolerateMissingAssets?: boolean;
  /** Diagram title, used for the file name and the draw.io page name. */
  name?: string | undefined;
  /** Governance finding markers on AI flow diagrams (default true). */
  aiFindings?: boolean;
}

const FONT = `font-family="'IBM Plex Sans', system-ui, sans-serif"`;

interface BuiltSvg { svg: string; width: number; height: number }

function marker(x: number, y: number, n: number): string {
  return `<g><circle cx="${x}" cy="${y}" r="${FOOTNOTE_RADIUS}" fill="#0f62fe" stroke="white" stroke-width="1.5"/><text x="${x}" y="${y}" ${FONT} font-size="11" font-weight="600" fill="white" text-anchor="middle" dominant-baseline="central">${n}</text></g>`;
}

async function buildSvg(source: DiagramDocument, assets: Map<string, Blob>, background: 'white' | 'transparent', includeGrid: boolean, options: DiagramExportOptions): Promise<BuiltSvg> {
  const view = collapseView(source);
  const document: DiagramDocument = { ...source, nodes: view.nodes, edges: view.edges };
  const byId = nodeMap(document.nodes);
  const lineJumps = diagramLineJumpGeometry(document);
  const content = diagramBounds(document, 0);
  const fns = (options.footnotes ?? true) ? footnotesOf(source) : [];
  const rows = (options.legend ?? source.legend?.visible === true) ? legendRows(source).filter((r) => !r.hidden) : [];
  const ink = background === 'white' ? '#161616' : '#525252';
  const extras: string[] = [];
  const block = fns.length > 0 ? footnoteBlock(source, content, source.notesPanel ?? 'bottom') : null;
  const rects: Rect[] = [content];
  if (block !== null) {
    rects.push(block.rect);
    extras.push(`<line x1="${block.divider.x}" x2="${block.divider.x + block.divider.width}" y1="${block.divider.y}" y2="${block.divider.y}" stroke="#8d8d8d" stroke-opacity="0.65" stroke-width="1" stroke-dasharray="6 6"/>`);
    extras.push(`<text x="${block.heading.x}" y="${block.heading.y}" ${FONT} font-size="${NOTE_HEADING_FONT}" font-weight="600" fill="${ink}" dominant-baseline="hanging">Notes</text>`);
    for (const item of block.items) {
      extras.push(marker(item.marker.x, item.marker.y, item.number));
      extras.push(`<text ${FONT} font-size="${NOTE_FONT}" fill="${ink}">${item.lines.map((line) => `<tspan x="${line.x}" y="${line.y}"${line.bold ? ' font-weight="600"' : ''}>${line.runs === undefined ? escapeXml(line.text) : line.runs.map(run => `<tspan font-weight="${run.bold ? 600 : 400}" font-style="${run.italic ? 'italic' : 'normal'}">${escapeXml(run.text)}</tspan>`).join('')}</tspan>`).join('')}</text>`);
    }
  }
  if (rows.length > 0) {
    const key = keyLayout(rows, boundsOf(rects) ?? content, content.x);
    extras.push(`<text x="${key.heading.x}" y="${key.heading.y}" ${FONT} font-size="13" font-weight="600" fill="${ink}" dominant-baseline="hanging">Key</text>`);
    for (const k of key.items) {
      extras.push(`<rect x="${k.x}" y="${k.y}" width="16" height="14" rx="2" fill="none" stroke="${escapeXml(k.colour)}" stroke-width="2.5"/><text x="${k.x + 24}" y="${k.y + 7}" ${FONT} font-size="${NOTE_FONT}" fill="${ink}" dominant-baseline="central">${escapeXml(k.text)}</text>`);
    }
    rects.push(key.rect);
  }
  const all = boundsOf(rects) ?? content;
  const bounds = { x: all.x - 24, y: all.y - 24, width: all.width + 48, height: all.height + 48 };
  const width = Math.max(1, Math.ceil(bounds.width));
  const height = Math.max(1, Math.ceil(bounds.height));
  const maskIds = new Map([...lineJumps.masks.keys()].map((id, index) => [id, `jump-${index}`]));
  const maskFor = (id: string): string => maskIds.has(id) ? ` mask="url(#${maskIds.get(id)})"` : '';
  const maskDefinitions = [...lineJumps.masks].map(([id, masks]) =>
    `<mask id="${maskIds.get(id)}" maskUnits="userSpaceOnUse" x="${bounds.x}" y="${bounds.y}" width="${width}" height="${height}"><rect x="${bounds.x}" y="${bounds.y}" width="${width}" height="${height}" fill="white"/>${masks.map(mask => `<path d="${mask.d}" fill="none" stroke="black" stroke-width="${mask.width}"/>`).join('')}</mask>`);
  const embedded = new Map<string, string>();
  const aiFlow = isAiFlowDoc(source);
  const roleSvgs = new Map<string, string>();
  if (document.nodes.some(node => diagramRoleLayout(node, aiFlow) !== null)) {
    const { renderToStaticMarkup } = await import('react-dom/server');
    for (const node of document.nodes) {
      const layout = diagramRoleLayout(node, aiFlow);
      if (layout !== null) roleSvgs.set(node.id, renderToStaticMarkup(createElement(DiagramRoleBadge, { layout })));
    }
  }
  const aiFindings = aiFlow && options.aiFindings !== false ? findingsByTarget(checkAiFlow(source)) : new Map<string, AiTargetFindings>();
  for (const node of document.nodes) {
    if (node.assetId !== null && !embedded.has(node.assetId)) {
      const asset = assets.get(node.assetId);
      if (!asset) {
        if (options.tolerateMissingAssets === true) continue;
        throw new Error(`The icon for "${descriptionPlainText(node.label) || 'Image'}" has not loaded. Retry before exporting.`);
      }
      embedded.set(node.assetId, await readDataUrl(asset));
    }
  }
  const nodes = renderOrder(document.nodes).map((stored) => {
    const node = { ...stored, ...diagramEditorNodeColours(stored) };
    const role = diagramRoleLayout(node, aiFlow);
    const strokeWidth = diagramNodeStrokeWidth(stored);
    const dash = diagramBorderDash(node);
    const borderStyle = `${dash === undefined ? '' : ` stroke-dasharray="${dash}"`}${node.strokeStyle === 'dotted' ? ' stroke-linecap="round"' : ''}`;
    const colour = `fill="${escapeXml(node.fill)}" stroke="${escapeXml(node.stroke)}" stroke-width="${strokeWidth}"${borderStyle}`;
    let shape = '';
    if (node.kind === 'line') {
      const [start, end] = linePoints(node);
      const jump = lineJumps.paths.get(node.id);
      shape = `<${jump === undefined ? `line x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}"` : `path d="${jump}"`} fill="none" stroke="${escapeXml(node.stroke)}" stroke-width="${strokeWidth}"${borderStyle}${maskFor(node.id)}/>`;
    } else if (node.kind === 'document') {
      shape = `<path d="${documentShapePath(node)}" ${colour}/>`;
    } else if (node.kind === 'arrow') {
      shape = `<path d="${arrowShapePath(node, node.arrowDirection)}" ${colour} stroke-linejoin="round"/>`;
    } else if (node.kind === 'decision') {
      shape = `<path d="${decisionShapePath(node)}" ${colour}/>`;
    } else if (node.kind === 'hexagon') {
      shape = `<path d="${hexagonShapePath(node)}" ${colour} stroke-linejoin="round"/>`;
    } else {
      const radius = diagramNodeRadius(node);
      shape = `<rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="${radius}" ${colour}/>`;
      if (node.kind === 'container') shape += `<line x1="${node.x}" x2="${node.x + node.width}" y1="${node.y + containerHeader(node).height}" y2="${node.y + containerHeader(node).height}" stroke="${escapeXml(node.stroke)}" stroke-width="${node.strokeWidth ?? 1}"${borderStyle}/>`;
      if (node.kind === 'swimlane') shape += `<rect x="${node.x}" y="${node.y}" width="${SWIMLANE_HEADER}" height="${node.height}" fill="${node.stroke === 'none' ? '#e0e0e0' : escapeXml(node.stroke)}" fill-opacity="0.1" stroke="${escapeXml(node.stroke)}" stroke-width="${strokeWidth}"${borderStyle}/>`;
    }
    if (diagramNodeShadow(stored)) shape = `<g filter="url(#diagram-shadow)">${shape}</g>`;
    if (node.assetId !== null && embedded.has(node.assetId)) {
      const captionHeight = node.label.trim() ? Math.round(node.fontSize * 1.3 + 10) : 0;
      shape += `<image x="${node.x + 4}" y="${node.y + 4}" width="${Math.max(1, node.width - 8)}" height="${Math.max(1, node.height - captionHeight - 8)}" preserveAspectRatio="xMidYMid meet" href="${escapeXml(embedded.get(node.assetId) ?? '')}"/>`;
    }
    if (view.hiddenCount.has(node.id)) {
      const header = Math.min(node.height, node.kind === 'swimlane' ? node.height : containerHeader(node).height);
      shape += `<text x="${node.x + node.width - 10}" y="${node.y + header / 2}" ${FONT} font-size="11" fill="${escapeXml(node.textColor)}" text-anchor="end" dominant-baseline="central">+${view.hiddenCount.get(node.id)}</text>`;
    }
    const owner = aiFlow ? aiLaneOwnerLayout(node) : null;
    const shifted = owner !== null && node.textAlign === undefined && node.textVerticalAlign === undefined ? owner.titleShift : 0;
    const ownerSvg = owner === null ? '' : `<g data-ai-lane-owner="true" transform="${owner.rotation}">${textLines([owner.text], owner.x, owner.y, owner.fontSize, node.textColor, 'middle', 400)}</g>`;
    const finding = aiFindings.get(node.id);
    const chips = aiFlow ? aiStepChips(node, finding !== undefined, node.header !== undefined || (role?.label ?? null) !== null).map(chipSvg).join('') : '';
    const findingMark = finding === undefined ? '' : findingSvg(aiFindingAnchor(node), finding);
    return `<g>${shape}${node.kind === 'line' ? '' : nodeText(node, shifted, role)}${roleSvgs.get(node.id) ?? ''}${ownerSvg}${calloutHeader(node)}${chips}${findingMark}</g>`;
  });
  const shadow = `<filter id="diagram-shadow" x="-20%" y="-30%" width="140%" height="180%">${DIAGRAM_SHADOWS.map(s => `<feDropShadow dx="${s.dx}" dy="${s.dy}" stdDeviation="${s.stdDeviation}" flood-color="${s.floodColor}" flood-opacity="${s.floodOpacity}"/>`).join('')}</filter>`;
  const definitions: string[] = [...maskDefinitions, shadow];
  const edgeSvg = document.edges.map((edge, i) => {
    const appearance = diagramEdgeAppearance(edge);
    const points = edgeRoute(edge, byId) ?? [];
    if (points.length < 2) throw new Error(`Connector "${descriptionPlainText(edge.label)}" is not attached to two shapes`);
    definitions.push(`<marker id="arrow-${i}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="${20 / 3}" markerHeight="${20 / 3}" markerUnits="strokeWidth" orient="auto-start-reverse"><path d="M0,1 L10,5 L0,9 z" fill="${escapeXml(appearance.stroke)}"/></marker>`);
    const middle = edgeLabelCenter(points, edge);
    const jump = lineJumps.paths.get(edge.id);
    const path = `<path d="${jump ?? roundedRoutePath(points)}" fill="none" stroke="${escapeXml(appearance.stroke)}" stroke-width="${appearance.width}" stroke-linecap="round" stroke-linejoin="round"${appearance.dash === undefined ? '' : ` stroke-dasharray="${appearance.dash}"`}${edge.arrows === 'end' || edge.arrows === 'both' ? ` marker-end="url(#arrow-${i})"` : ''}${edge.arrows === 'both' || edge.arrows === 'start' ? ` marker-start="url(#arrow-${i})"` : ''}${maskFor(edge.id)}/>`;
    const { lines, width: labelW, height: labelH, fontSize, lineHeight } = edgeLabelLayout(edge);
    const label = edge.label.trim() ? `<rect x="${middle.x - labelW / 2}" y="${middle.y - labelH / 2}" width="${labelW}" height="${labelH}" rx="${labelH / 2}" fill="white" stroke="${appearance.labelBorder}" stroke-width="1"/><text x="${middle.x}" y="${middle.y - labelH / 2 + 3 + fontSize}" font-family="'IBM Plex Sans', system-ui, sans-serif" font-size="${fontSize}" font-weight="600" text-anchor="middle" fill="${escapeXml(appearance.label)}">${lineSvg(edge.label, lines).map((line, j) => `<tspan x="${middle.x}" dy="${j === 0 ? 0 : lineHeight}">${line}</tspan>`).join('')}</text>` : '';
    const edgeChip = aiFlow ? aiEdgeChip(edge, points) : null;
    const edgeFinding = aiFindings.get(edge.id);
    const aiMarks = `${edgeChip === null ? '' : chipSvg(edgeChip)}${edgeFinding === undefined ? '' : findingSvg(aiEdgeFindingAnchor(points), edgeFinding)}`;
    return `${path}${label}${aiMarks}`;
  });
  const behindEdges = edgeSvg.filter((_, i) => document.edges[i]?.behind === true);
  const edges = edgeSvg.filter((_, i) => document.edges[i]?.behind !== true);
  const markers = fns.flatMap((fn, i) => {
    const target = view.hiddenBy.get(fn.targetId) ?? fn.targetId;
    const at = footnoteAnchor(document, target, byId);
    return at === null ? [] : [marker(at.x, at.y, i + 1)];
  });
  const grid = includeGrid ? `<pattern id="export-grid" width="${source.gridSize ?? 10}" height="${source.gridSize ?? 10}" patternUnits="userSpaceOnUse"><circle cx="0" cy="0" r="1" fill="#e0e0e0"/></pattern>` : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${bounds.x} ${bounds.y} ${width} ${height}"><defs>${grid}${definitions.join('')}</defs>${background === 'white' ? `<rect x="${bounds.x}" y="${bounds.y}" width="${width}" height="${height}" fill="white"/>` : ''}${includeGrid ? `<rect x="${bounds.x}" y="${bounds.y}" width="${width}" height="${height}" fill="url(#export-grid)"/>` : ''}${behindEdges.join('')}${nodes.join('')}${edges.join('')}${markers.join('')}${extras.join('')}</svg>`;
  return { svg, width, height };
}

export async function diagramSvg(document: DiagramDocument, assets: Map<string, Blob>, background: 'white' | 'transparent', includeGrid = false, options: DiagramExportOptions = {}): Promise<string> {
  return (await buildSvg(document, assets, background, includeGrid, options)).svg;
}

export type DiagramExportFormat = 'png' | 'svg' | 'drawio';

/** A safe file name from the diagram title. */
export function exportFileName(name: string | undefined, format: DiagramExportFormat): string {
  const base = (name ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
  return `${base === '' ? 'diagram' : base}.${format}`;
}

export function download(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = window.document.createElement('a');
  link.href = url; link.download = fileName;
  window.document.body.append(link);
  link.click(); link.remove();
  // Keep the URL alive until the browser has started the download.
  window.setTimeout(() => { URL.revokeObjectURL(url); }, 30_000);
}

export async function exportDiagram(document: DiagramDocument, assets: Map<string, Blob>, format: DiagramExportFormat, background: 'white' | 'transparent', includeGrid = false, options: DiagramExportOptions = {}): Promise<void> {
  const blob = await diagramExportBlob(document, assets, format, background, includeGrid, options);
  download(blob, exportFileName(options.name, format));
}

export async function diagramExportBlob(document: DiagramDocument, assets: Map<string, Blob>, format: DiagramExportFormat, background: 'white' | 'transparent', includeGrid = false, options: DiagramExportOptions = {}): Promise<Blob> {
  if (format === 'drawio') {
    const images = new Map<string, string>();
    for (const [id, blob] of assets) images.set(id, await readDataUrl(blob));
    const xml = diagramDrawioXml(document, images, options);
    return new Blob([xml], { type: 'application/xml' });
  }
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
  return blob;
}
