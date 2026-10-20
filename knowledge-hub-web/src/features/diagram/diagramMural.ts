import type { MuralConnector, MuralDiagramExport, MuralObject } from '../../types/mural';
import type { DiagramDocument, DiagramNode } from './diagramTypes';
import { boundsOf, diagramBounds, edgeLabelCenter, edgeRoute, fitSize, linePoints, nodeMap, renderOrder } from './diagramGeometry';
import { footnoteAnchor, footnoteBlock, footnotesOf, keyLayout, legendRows, FOOTNOTE_RADIUS, NOTE_FONT } from './diagramAnnotations';
import { descriptionPlainText } from './diagramDescription';
import { DIAGRAM_CALLOUTS } from './diagramCallouts';
import { aiStepSummary } from './diagramAiFlowBadges';
import { diagramTextLayout } from './diagramText';

const colour = (value: string): string => {
  if (value === 'none' || value === 'transparent' || !value) return '#FFFFFF00';
  if (/^#[a-f\d]{3}$/i.test(value)) return `#${[...value.slice(1)].map(c => c + c).join('')}FF`.toUpperCase();
  if (/^#[a-f\d]{6}$/i.test(value)) return `${value}FF`.toUpperCase();
  if (/^#[a-f\d]{8}$/i.test(value)) return value.toUpperCase();
  throw new Error(`Mural cannot export the colour "${value}". Choose a hex colour first.`);
};

const SHAPES: Partial<Record<DiagramNode['kind'], string>> = {
  process: 'rounded_square', decision: 'rhombus_smart', terminator: 'terminator', document: 'document', image: 'rectangle',
};
const ARROWS = { right: 'arrow_right', left: 'arrow_left', up: 'arrow_top', down: 'arrow_down', 'left-right': 'arrow_left_right', 'up-down': 'arrow_left_right' } as const;

function boardInk(value: string): string {
  const hex = colour(value);
  const rgb = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
  return Math.min(...rgb) >= 160 ? '#161616FF' : hex;
}

async function assetPng(blob: Blob): Promise<string> {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const size = fitSize(image.naturalWidth, image.naturalHeight, 2048, 2048);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(size.width));
    canvas.height = Math.max(1, Math.round(size.height));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not prepare the diagram icon for Mural.');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  } finally { URL.revokeObjectURL(url); }
}

/** Native objects use the same absolute layout as Athena; the server resolves Mural IDs and area offsets. */
export async function diagramMural(doc: DiagramDocument, assets: ReadonlyMap<string, Blob>,
  options: { boardUrl: string; title: string; footnotes: boolean; legend: boolean }): Promise<MuralDiagramExport> {
  const objects: MuralObject[] = [];
  const connectors: MuralConnector[] = [];
  const byId = nodeMap(doc.nodes);
  const content = diagramBounds(doc, 0);
  const regions = [content];
  const dx = 100 - content.x, dy = 100 - content.y;
  const point = (p: { x: number; y: number }) => ({ x: p.x + dx, y: p.y + dy });
  const addText = (id: string, text: string, x: number, y: number, width: number, height: number, fontSize = NOTE_FONT): void => {
    objects.push({ id, type: 'textbox', shape: '', text, x: x + dx, y: y + dy, width: Math.max(1, width), height: Math.max(1, height),
      parentId: null, fill: '#FFFFFF00', stroke: '#FFFFFF00', strokeWidth: 1, dotted: false, textColor: '#161616FF', fontSize, align: 'left' });
  };
  const images = new Map<string, string>();
  for (const n of renderOrder(doc.nodes)) {
    if (n.kind === 'line') {
      const points = linePoints(n).map(point);
      connectors.push({ id: n.id, sourceId: null, targetId: null, points, route: 'straight', arrows: 'none',
        stroke: colour(n.stroke), strokeWidth: Math.min(7, Math.max(1, n.strokeWidth ?? 1.5)), dashed: n.strokeStyle !== undefined && n.strokeStyle !== 'solid',
        text: '', fontSize: n.fontSize, label: points[0]! });
      continue;
    }
    const isArea = n.kind === 'container' || n.kind === 'swimlane';
    let text = descriptionPlainText(n.label);
    if (n.calloutType) text = `${DIAGRAM_CALLOUTS[n.calloutType].label}: ${text}`;
    if (n.lane?.owner) text += `\n${n.lane.owner}`;
    const object: MuralObject = { id: n.id, type: isArea ? 'area' : n.kind === 'text' ? 'textbox' : 'shape',
      shape: n.kind === 'arrow' ? ARROWS[n.arrowDirection ?? 'right'] : SHAPES[n.kind] ?? '',
      text, ...point(n), width: n.width, height: n.height,
      parentId: n.parentId !== null && ['container', 'swimlane'].includes(byId.get(n.parentId)?.kind ?? '') ? n.parentId : null,
      fill: '#FFFFFF00', stroke: colour(n.stroke), strokeWidth: Math.min(7, Math.max(1, n.strokeWidth ?? 1.5)),
      dotted: n.strokeStyle === 'dotted', textColor: boardInk(n.textColor), fontSize: n.fontSize,
      align: n.textAlign ?? (isArea ? 'left' : 'center') };
    if (n.kind === 'arrow' && n.arrowDirection === 'up-down') {
      object.rotation = 90;
      object.width = n.height; object.height = n.width;
      object.x += (n.width - n.height) / 2; object.y += (n.height - n.width) / 2;
    }
    objects.push(object);
    if (isArea && text.trim()) {
      const layout = diagramTextLayout({ ...n, label: text });
      const width = Math.max(1, layout.rotation ? n.height - 16 : n.width - 20);
      const height = Math.max(1, n.fontSize * 1.25 * layout.lines.length);
      const x = layout.x - (layout.anchor === 'middle' ? width / 2 : layout.anchor === 'end' ? width : 0);
      objects.push({ ...object, id: `${n.id}-title`, type: 'textbox', shape: '', text: layout.lines.join('\n'),
        x: x + dx, y: layout.y + dy - height / 2, width, height, parentId: n.id,
        stroke: '#FFFFFF00', align: layout.anchor === 'middle' ? 'center' : layout.anchor === 'end' ? 'right' : 'left',
        rotation: layout.rotation ? 270 : 0 });
    }
    if (n.assetId !== null) {
      let image = images.get(n.assetId);
      if (!image) {
        const blob = assets.get(n.assetId);
        if (!blob) throw new Error('A diagram icon is still loading. Retry images before exporting.');
        image = await assetPng(blob); images.set(n.assetId, image);
      }
      if (n.kind === 'image') {
        object.type = 'image'; object.image = image;
      } else {
        const size = await imageSize(image, Math.max(1, n.width - 8), Math.max(1, n.height - n.fontSize * 1.3 - 18));
        objects.push({ ...object, id: `${n.id}-asset`, type: 'image', text: '', shape: '', image,
          x: object.x + (n.width - size.width) / 2, y: object.y + 4, ...size });
      }
    }
    if (n.description?.trim() || n.flow) {
      const details = [n.description ? descriptionPlainText(n.description) : '', n.flow ? aiStepSummary(n) : ''].filter(Boolean).join('\n\n');
      object.instruction = details;
    }
  }
  for (const e of doc.edges) {
    const route = edgeRoute(e, byId);
    if (!route) throw new Error('A connector has a missing endpoint. Repair it before exporting to Mural.');
    connectors.push({ id: e.id, sourceId: e.sourceId, targetId: e.targetId, points: route.map(point), route: e.route, arrows: e.arrows,
      stroke: colour(e.stroke), strokeWidth: Math.min(7, Math.max(1, e.strokeWidth ?? 1.5)), dashed: e.dashed,
      text: descriptionPlainText(e.label), fontSize: e.fontSize ?? 12, label: point(edgeLabelCenter(route, e)) });
  }
  const badge = (id: string, number: number, at: { x: number; y: number }): void => {
    objects.push({ id, type: 'shape', shape: 'ellipse', text: String(number), x: at.x + dx - FOOTNOTE_RADIUS, y: at.y + dy - FOOTNOTE_RADIUS,
      width: FOOTNOTE_RADIUS * 2, height: FOOTNOTE_RADIUS * 2, parentId: null, fill: '#0F62FEFF', stroke: '#FFFFFFFF',
      strokeWidth: 1, dotted: false, textColor: '#FFFFFFFF', fontSize: 11, align: 'center' });
  };
  if (options.footnotes) {
    footnotesOf(doc).forEach((fn, i) => { const at = footnoteAnchor(doc, fn.targetId, byId); if (at) badge(`footnote-${fn.id}`, i + 1, at); });
    const block = footnoteBlock(doc, content, doc.notesPanel ?? 'bottom');
    if (block) {
      regions.push(block.rect);
      addText('notes-heading', 'Notes', block.heading.x, block.heading.y, 120, 24, 14);
      for (const item of block.items) {
        badge(`note-badge-${item.id}`, item.number, item.marker);
        const x = item.lines[0]?.x ?? item.rect.x;
        addText(`note-${item.id}`, item.lines.map(l => l.text).join('\n'), x, item.rect.y + 4, item.rect.x + item.rect.width - x, item.rect.height);
      }
    }
  }
  const rows = options.legend ? legendRows(doc).filter(r => !r.hidden) : [];
  if (rows.length > 0) {
    const key = keyLayout(rows, boundsOf(regions) ?? content, content.x);
    addText('key-heading', 'Key', key.heading.x, key.heading.y, 120, 24, 14);
    key.items.forEach((item, i) => {
      objects.push({ id: `key-swatch-${i}`, type: 'shape', shape: 'rectangle', text: '', ...point(item), width: 16, height: 14,
        parentId: null, fill: '#FFFFFF00', stroke: colour(item.colour), strokeWidth: 2.5, dotted: false, textColor: '#161616FF', fontSize: 12, align: 'left' });
      addText(`key-text-${i}`, item.text, item.x + 24, item.y - 3, 280, 24);
    });
  }
  return { boardUrl: options.boardUrl, title: options.title, objects, connectors };
}

async function imageSize(src: string, width: number, height: number): Promise<{ width: number; height: number }> {
  const image = new Image(); image.src = src; await image.decode();
  return fitSize(image.naturalWidth, image.naturalHeight, width, height);
}
