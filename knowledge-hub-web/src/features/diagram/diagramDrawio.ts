/**
 * draw.io (diagrams.net) export: the diagram as an editable .drawio file.
 *
 * Shapes, groups, lanes, connectors (with ports, bends, arrows and label offsets), lines, icons and
 * descriptions (as draw.io tooltips) map one-to-one. Footnote badges, the notes and the colour key
 * become ordinary draw.io shapes and text, placed where the PNG/SVG export puts them. Collapsed
 * groups are exported expanded so nothing is lost. AI flow step, lane and connector details become
 * draw.io custom properties (ai*) plus a tooltip summary; lane owners appear under the lane title.
 */
import type { DiagramDocument, DiagramEdge, DiagramNode, DiagramPort } from './diagramTypes';
import { footnoteAnchor, footnoteBlock, footnotesOf, keyLayout, legendRows, FOOTNOTE_RADIUS, NOTE_FONT, NOTE_HEADING_FONT } from './diagramAnnotations';
import { ARROW_SHAFT, arrowAxis, arrowHeadLength, boundsOf, containerHeader, diagramBounds, linePoints, nodeMap, renderOrder, SWIMLANE_HEADER, type Rect } from './diagramGeometry';
import { calloutLayout } from './diagramCallouts';
import { AGENT_MODE_BADGES, AGENT_MODE_LABELS, ASSERTION_LABELS, EDGE_TYPE_LABELS, INTERACTION_LABELS, SENSITIVITY_LABELS, STATE_LABELS, STEP_TYPE_LABELS, controlCount } from './aiFlow';
import { aiStepSummary } from './diagramAiFlowBadges';
import { descriptionPlainText } from './diagramDescription';

export interface DrawioOptions {
  footnotes?: boolean | undefined;
  legend?: boolean | undefined;
  /** Page name shown in draw.io. */
  name?: string | undefined;
}

const xml = (text: string): string => text.replace(/[<>&"']/g, (c) => ({
  '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
}[c] ?? c));

/** A plain-text label as draw.io html label content (escaped, line breaks kept). */
const htmlLabel = (text: string): string => xml(text).replace(/\r?\n/g, '<br>');

const colour = (c: string | undefined, fallback = 'none'): string => {
  const v = (c ?? '').trim();
  return v === '' || v === 'none' || v === 'transparent' ? fallback : v;
};

const style = (parts: Record<string, string | number | undefined>): string =>
  Object.entries(parts).filter(([, v]) => v !== undefined).map(([k, v]) => (v === '' ? k : `${k}=${String(v)}`)).join(';') + ';';

const PORT: Record<DiagramPort, [number, number]> = { top: [0.5, 0], right: [1, 0.5], bottom: [0.5, 1], left: [0, 0.5] };

function borderStyle(n: Pick<DiagramNode, 'strokeStyle'>): Record<string, string | number> {
  if (n.strokeStyle === 'dashed') return { dashed: 1 };
  if (n.strokeStyle === 'dotted') return { dashed: 1, dashPattern: '1 3' };
  return {};
}

const DRAWIO_DIRECTION = { right: 'east', left: 'west', up: 'north', down: 'south' } as const;

function shapeStyle(n: DiagramNode, hasChildren: boolean): string {
  const common = {
    html: 1, whiteSpace: 'wrap',
    fillColor: colour(n.fill), strokeColor: colour(n.stroke), strokeWidth: n.strokeWidth ?? 1.5,
    fontColor: colour(n.textColor, '#161616'), fontSize: n.fontSize,
    ...borderStyle(n),
  };
  const align = n.textAlign ?? (n.kind === 'container' ? 'left' : 'center');
  const verticalAlign = n.textVerticalAlign ?? (n.kind === 'image' && n.textAlign === undefined ? 'bottom' : 'middle');
  const children = hasChildren ? { container: 1 } : {};
  const callout = calloutLayout(n);
  switch (n.kind) {
    case 'container':
      return style({ swimlane: '', ...common, startSize: containerHeader(n).height, fontStyle: 1, align, spacingLeft: 4, collapsible: 1, container: 1 });
    case 'swimlane':
      return style({ swimlane: '', ...common, horizontal: 0, startSize: SWIMLANE_HEADER, fontStyle: 1, collapsible: 1, container: 1 });
    case 'decision':
      return style({ rhombus: '', ...common, align, verticalAlign, ...children });
    case 'document':
      return style({ shape: 'document', ...common, boundedLbl: 1, size: 0.15, align, verticalAlign, ...children });
    case 'arrow': {
      const direction = n.arrowDirection ?? 'right';
      const along = arrowAxis(direction) === 'horizontal' ? n.width : n.height;
      return style({ shape: 'singleArrow', ...common, direction: DRAWIO_DIRECTION[direction], arrowWidth: ARROW_SHAFT,
        arrowSize: Math.round(arrowHeadLength(n, direction) / along * 1000) / 1000, align, verticalAlign, ...children });
    }
    case 'terminator':
      return style({ rounded: 1, arcSize: 50, ...common, align, verticalAlign, ...children });
    case 'text':
      return style({ text: '', ...common, align: n.textAlign ?? 'center', verticalAlign,
        ...(callout !== null ? { spacingTop: callout.height } : {}), ...children });
    case 'image':
      return style({ rounded: 1, absoluteArcSize: 1, arcSize: 8, ...common, align, verticalAlign, spacingBottom: 2, ...children });
    default:
      return style({ rounded: 1, absoluteArcSize: 1, arcSize: 12, ...common, align, verticalAlign, ...children });
  }
}

/** draw.io wants `data:<type>,<base64>` (no `;base64`, since `;` separates style entries). */
export function drawioImage(dataUrl: string): string {
  return dataUrl.replace(/^data:([^;,]+);base64,/, 'data:$1,');
}

interface Cell { id: string; xml: string }

function vertexCell(id: string, value: string, styleText: string, parent: string, r: Rect, tooltip?: string, data: Record<string, string> = {}): Cell {
  const geometry = `<mxGeometry x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" as="geometry"/>`;
  const hasTooltip = tooltip !== undefined && tooltip.trim() !== '';
  if (hasTooltip || Object.keys(data).length > 0) {
    return { id, xml: `<UserObject label="${xml(value)}"${hasTooltip ? ` tooltip="${xml(tooltip)}"` : ''}${dataAttrs(data)} id="${xml(id)}"><mxCell style="${xml(styleText)}" vertex="1" parent="${xml(parent)}">${geometry}</mxCell></UserObject>` };
  }
  return { id, xml: `<mxCell id="${xml(id)}" value="${xml(value)}" style="${xml(styleText)}" vertex="1" parent="${xml(parent)}">${geometry}</mxCell>` };
}

const dataAttrs = (data: Record<string, string>): string => Object.entries(data).map(([k, v]) => ` ${k}="${xml(v)}"`).join('');

const joinTooltip = (...parts: (string | undefined)[]): string => parts.filter((p): p is string => p !== undefined && p.trim() !== '').join('\n\n');

/** AI flow step and lane details as draw.io custom properties (Edit Data shows them). */
function aiNodeData(n: DiagramNode): Record<string, string> {
  const out: Record<string, string> = {};
  if (n.lane !== undefined) {
    out.aiLaneOrder = String(n.lane.order);
    if ((n.lane.owner ?? '').trim() !== '') out.aiLaneOwner = n.lane.owner!.trim();
    if ((n.lane.description ?? '').trim() !== '') out.aiLaneDescription = n.lane.description!.trim();
  }
  const flow = n.flow;
  if (flow === undefined) return out;
  out.aiStepType = STEP_TYPE_LABELS[flow.stepType];
  if (flow.state !== undefined) out.aiState = STATE_LABELS[flow.state];
  if (flow.actor !== undefined && flow.actor.trim() !== '') out.aiActor = flow.actor.trim();
  const agent = flow.agent;
  if (agent?.mode !== undefined) out.aiAutonomy = `${AGENT_MODE_BADGES[agent.mode]} ${AGENT_MODE_LABELS[agent.mode]}`;
  if (agent?.assertion !== undefined) out.aiAssertion = ASSERTION_LABELS[agent.assertion];
  if ((agent?.tools ?? []).length > 0) out.aiTools = agent!.tools!.join(', ');
  if ((agent?.guardrails ?? []).length > 0) out.aiGuardrails = agent!.guardrails!.join(', ');
  if (flow.controls?.sensitivity !== undefined) out.aiSensitivity = SENSITIVITY_LABELS[flow.controls.sensitivity];
  out.aiControls = String(controlCount(flow));
  return out;
}

function aiEdgeData(e: DiagramEdge): Record<string, string> {
  const flow = e.flow;
  if (flow === undefined) return {};
  const out: Record<string, string> = { aiEdgeType: EDGE_TYPE_LABELS[flow.edgeType] };
  if (flow.interaction !== undefined) out.aiInteraction = INTERACTION_LABELS[flow.interaction];
  if (flow.sensitivity !== undefined) out.aiSensitivity = SENSITIVITY_LABELS[flow.sensitivity];
  if ((flow.payload ?? '').trim() !== '') out.aiPayload = flow.payload!.trim();
  if ((flow.condition ?? '').trim() !== '') out.aiCondition = flow.condition!.trim();
  if ((flow.auth ?? '').trim() !== '') out.aiAuth = flow.auth!.trim();
  return out;
}

const dataSummary = (data: Record<string, string>): string => Object.entries(data)
  .map(([k, v]) => `${k.replace(/^ai/, '').replace(/([a-z])([A-Z])/g, '$1 $2')}: ${v}`).join('\n');

function edgeStyle(e: DiagramEdge): string {
  const [sx, sy] = PORT[e.sourcePort];
  const [tx, ty] = PORT[e.targetPort];
  const arrow = { endArrow: e.arrows === 'none' || e.arrows === 'start' ? 'none' : 'block', endFill: 1, startArrow: e.arrows === 'both' || e.arrows === 'start' ? 'block' : 'none', startFill: 1 };
  return style({
    edgeStyle: e.route === 'orthogonal' ? 'orthogonalEdgeStyle' : 'none', rounded: 0, html: 1, jumpStyle: 'arc', jumpSize: 6,
    strokeColor: colour(e.stroke, '#161616'), strokeWidth: e.strokeWidth ?? 1.5, ...(e.dashed ? { dashed: 1 } : {}), ...arrow,
    fontSize: e.fontSize ?? 11, fontColor: colour(e.stroke, '#161616'), labelBackgroundColor: '#ffffff',
    exitX: sx, exitY: sy, exitDx: 0, exitDy: 0, exitPerimeter: 0,
    entryX: tx, entryY: ty, entryDx: 0, entryDy: 0, entryPerimeter: 0,
  });
}

/**
 * The diagram as a draw.io file. `images` maps asset ids to data URLs (the caller reads the blobs).
 * Nodes are absolute in Athena; draw.io children are relative to their parent, so geometry is offset.
 */
export function diagramDrawioXml(doc: DiagramDocument, images: ReadonlyMap<string, string>, options: DrawioOptions = {}): string {
  const byId = nodeMap(doc.nodes);
  const parentIds = new Set(doc.nodes.flatMap((n) => (n.parentId !== null && byId.has(n.parentId) ? [n.parentId] : [])));
  const cells: Cell[] = [];
  const parentOf = (n: DiagramNode): DiagramNode | undefined => (n.parentId !== null ? byId.get(n.parentId) : undefined);
  const aiFlow = doc.diagramType === 'ai-flow';

  for (const n of renderOrder(doc.nodes)) {
    const parent = parentOf(n);
    const parentId = parent?.id ?? '1';
    const ox = parent?.x ?? 0;
    const oy = parent?.y ?? 0;
    if (n.kind === 'line') {
      const [a, b] = linePoints(n);
      const lineStyle = style({ endArrow: 'none', startArrow: 'none', html: 1, rounded: 0, jumpStyle: 'arc', jumpSize: 6, strokeColor: colour(n.stroke, '#161616'), strokeWidth: n.strokeWidth ?? 1.5, ...borderStyle(n) });
      cells.push({ id: n.id, xml: `<mxCell id="${xml(n.id)}" value="" style="${xml(lineStyle)}" edge="1" parent="${xml(parentId)}"><mxGeometry relative="1" as="geometry"><mxPoint x="${a.x - ox}" y="${a.y - oy}" as="sourcePoint"/><mxPoint x="${b.x - ox}" y="${b.y - oy}" as="targetPoint"/></mxGeometry></mxCell>` });
      continue;
    }
    const aiData = aiFlow ? aiNodeData(n) : {};
    const owner = aiFlow && n.kind === 'swimlane' ? (n.lane?.owner ?? '').trim() : '';
    const label = owner === '' ? htmlLabel(n.label) : `${htmlLabel(n.label)}<br><span style="font-size:10px;font-weight:normal">${htmlLabel(owner)}</span>`;
    cells.push(vertexCell(n.id, label, shapeStyle(n, parentIds.has(n.id)), parentId,
      { x: n.x - ox, y: n.y - oy, width: n.width, height: n.height }, joinTooltip(n.description === undefined ? undefined : descriptionPlainText(n.description), n.flow !== undefined && aiFlow ? aiStepSummary(n) : undefined), aiData));
    const callout = calloutLayout(n);
    if (callout !== null) {
      const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path d="${callout.path}" fill="none" stroke="${xml(colour(n.textColor, '#161616'))}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      cells.push(vertexCell(`${n.id}-callout-icon`, '', style({ shape: 'image', html: 1, imageAspect: 1, connectable: 0,
        image: `data:image/svg+xml,${encodeURIComponent(icon)}` }), n.id,
      { x: callout.icon.x - n.x, y: callout.icon.y - n.y, width: callout.icon.size, height: callout.icon.size }));
      cells.push(vertexCell(`${n.id}-callout-type`, callout.label, style({ text: '', html: 1, align: 'left', verticalAlign: 'middle',
        fontColor: colour(n.textColor, '#161616'), fontSize: callout.text.fontSize, fontStyle: 1, spacing: 0, connectable: 0 }), n.id,
      { x: callout.text.x - n.x, y: 0, width: Math.max(0, n.width - (callout.text.x - n.x) - 4), height: callout.height }));
    }
    const src = n.assetId !== null ? images.get(n.assetId) : undefined;
    if (src !== undefined) {
      const caption = n.label.trim() !== '' ? Math.round(n.fontSize * 1.3 + 10) : 0;
      cells.push(vertexCell(`${n.id}-image`, '', style({ shape: 'image', imageAspect: 1, aspect: 'fixed', html: 1, connectable: 0, image: drawioImage(src) }), n.id,
        { x: 4, y: 4, width: Math.max(1, n.width - 8), height: Math.max(1, n.height - caption - 8) }));
    }
  }

  for (const e of doc.edges) {
    if (!byId.has(e.sourceId) || !byId.has(e.targetId)) continue;
    const points = e.waypoints.length > 0 ? `<Array as="points">${e.waypoints.map((p) => `<mxPoint x="${p.x}" y="${p.y}"/>`).join('')}</Array>` : '';
    const offset = e.labelOffset !== undefined ? `<mxPoint x="${e.labelOffset.x}" y="${e.labelOffset.y}" as="offset"/>` : '';
    const geometry = `<mxGeometry relative="1" as="geometry">${points}${offset}</mxGeometry>`;
    const attrs = `style="${xml(edgeStyle(e))}" edge="1" parent="1" source="${xml(e.sourceId)}" target="${xml(e.targetId)}"`;
    const edgeData = aiFlow ? aiEdgeData(e) : {};
    const tooltip = joinTooltip(e.description === undefined ? undefined : descriptionPlainText(e.description), dataSummary(edgeData));
    cells.push(tooltip !== '' || Object.keys(edgeData).length > 0
      ? { id: e.id, xml: `<UserObject label="${xml(htmlLabel(e.label))}"${tooltip !== '' ? ` tooltip="${xml(tooltip)}"` : ''}${dataAttrs(edgeData)} id="${xml(e.id)}"><mxCell ${attrs}>${geometry}</mxCell></UserObject>` }
      : { id: e.id, xml: `<mxCell id="${xml(e.id)}" value="${xml(htmlLabel(e.label))}" ${attrs}>${geometry}</mxCell>` });
  }

  const content = diagramBounds(doc, 0);
  const regions: Rect[] = [content];
  const fns = (options.footnotes ?? true) ? footnotesOf(doc) : [];
  const badge = (id: string, n: number, cx: number, cy: number): Cell => vertexCell(id, String(n),
    style({ ellipse: '', html: 1, fillColor: '#0f62fe', strokeColor: '#ffffff', strokeWidth: 1.5, fontColor: '#ffffff', fontSize: 11, fontStyle: 1 }), '1',
    { x: cx - FOOTNOTE_RADIUS, y: cy - FOOTNOTE_RADIUS, width: FOOTNOTE_RADIUS * 2, height: FOOTNOTE_RADIUS * 2 });
  fns.forEach((fn, i) => {
    const at = footnoteAnchor(doc, fn.targetId, byId);
    if (at !== null) cells.push(badge(`footnote-${fn.id}`, i + 1, at.x, at.y));
  });
  const block = fns.length > 0 ? footnoteBlock(doc, content, doc.notesPanel ?? 'bottom') : null;
  if (block !== null) {
    regions.push(block.rect);
    cells.push({ id: 'notes-divider', xml: `<mxCell id="notes-divider" style="${xml(style({ endArrow: 'none', startArrow: 'none', strokeColor: '#8d8d8d', strokeOpacity: 65, strokeWidth: 1, dashed: 1, dashPattern: '6 6' }))}" edge="1" parent="1"><mxGeometry relative="1" as="geometry"><mxPoint x="${block.divider.x}" y="${block.divider.y}" as="sourcePoint"/><mxPoint x="${block.divider.x + block.divider.width}" y="${block.divider.y}" as="targetPoint"/></mxGeometry></mxCell>` });
    cells.push(vertexCell('notes-heading', 'Notes', style({ text: '', html: 1, align: 'left', verticalAlign: 'top', fontSize: NOTE_HEADING_FONT, fontStyle: 1, spacing: 0 }), '1',
      { x: block.heading.x, y: block.heading.y, width: 120, height: NOTE_HEADING_FONT + 6 }));
    for (const item of block.items) {
      cells.push(badge(`note-badge-${item.id}`, item.number, item.marker.x, item.marker.y));
      const textX = item.lines[0]?.x ?? item.rect.x;
      const value = item.lines.map(l => l.runs === undefined ? (l.bold ? `<b>${xml(l.text)}</b>` : xml(l.text))
        : l.runs.map(run => `${run.bold ? '<b>' : ''}${run.italic ? '<i>' : ''}${xml(run.text)}${run.italic ? '</i>' : ''}${run.bold ? '</b>' : ''}`).join('')).join('<br>');
      cells.push(vertexCell(`note-${item.id}`, value, style({ text: '', html: 1, whiteSpace: 'wrap', align: 'left', verticalAlign: 'top', fontSize: NOTE_FONT, spacing: 0 }), '1',
        { x: textX, y: item.rect.y + 4, width: item.rect.x + item.rect.width - textX, height: item.rect.height - 4 }));
    }
  }
  const rows = (options.legend ?? doc.legend?.visible === true) ? legendRows(doc).filter((r) => !r.hidden) : [];
  if (rows.length > 0) {
    const key = keyLayout(rows, boundsOf(regions) ?? content, content.x);
    cells.push(vertexCell('key-heading', 'Key', style({ text: '', html: 1, align: 'left', verticalAlign: 'top', fontSize: 13, fontStyle: 1, spacing: 0 }), '1',
      { x: key.heading.x, y: key.heading.y, width: 120, height: 20 }));
    key.items.forEach((k, i) => {
      cells.push(vertexCell(`key-swatch-${i.toString()}`, '', style({ rounded: 1, absoluteArcSize: 1, arcSize: 4, html: 1, fillColor: 'none', strokeColor: k.colour, strokeWidth: 2.5 }), '1',
        { x: k.x, y: k.y, width: 16, height: 14 }));
      cells.push(vertexCell(`key-label-${i.toString()}`, xml(k.text), style({ text: '', html: 1, align: 'left', verticalAlign: 'middle', fontSize: NOTE_FONT, spacing: 0 }), '1',
        { x: k.x + 24, y: k.y - 3, width: Math.min(260, k.text.length * 6.6) + 16, height: 20 }));
    });
  }

  const name = xml(options.name?.trim() || 'Diagram');
  const model = `<mxGraphModel dx="0" dy="0" grid="${doc.grid ? 1 : 0}" gridSize="20" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="0" pageScale="1" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells.map((c) => c.xml).join('')}</root></mxGraphModel>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<mxfile host="Athena" type="device"><diagram id="athena" name="${name}">${model}</diagram></mxfile>\n`;
}
