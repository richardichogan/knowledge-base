import React from 'react';
import { Bot, Chat, DataBase, DecisionTree, Locked, ToolKit, User, UserAdmin, Code, Task, Document, Folder, Cloud, Idea, Flow, Rocket, CheckmarkOutline, type CarbonIconType } from '@carbon/icons-react';
import { DIAGRAM_ICON_KINDS, type AiFlowStepType, type DiagramNode, type DiagramIconName } from './diagramTypes';
import { wrapText, type Rect } from './diagramGeometry';
import { diagramTextLayout } from './diagramText';

export const DIAGRAM_ROLES = {
  channel_interaction: { label: 'Channel', tint: '#d9fbfb', colour: '#007d79', ink: '#005d5d', icon: Chat },
  human_task: { label: 'Human', tint: '#edf5ff', colour: '#0f62fe', ink: '#0043ce', icon: User },
  digital_steward: { label: 'Steward', tint: '#fff0f7', colour: '#d02670', ink: '#9f1853', icon: UserAdmin },
  digital_worker: { label: 'Worker', tint: '#f6f2ff', colour: '#8a3ffc', ink: '#6929c4', icon: Bot },
  specialist_agent: { label: 'Specialist', tint: '#fff2e8', colour: '#eb6200', ink: '#8a3800', icon: ToolKit },
  decision_gate: { label: 'Gate', tint: '#fff1f1', colour: '#da1e28', ink: '#a2191f', icon: Locked },
  decision_rules: { label: 'Rules', tint: '#fffbeb', colour: '#b28600', ink: '#8e6a00', icon: DecisionTree },
  integration: { label: 'System', tint: '#f4f4f4', colour: '#525252', ink: '#393939', icon: DataBase },
  data_operation: { label: 'Data', tint: '#f4f4f4', colour: '#525252', ink: '#393939', icon: DataBase },
  external_party: { label: 'External', tint: '#f4f4f4', colour: '#525252', ink: '#393939', icon: User },
} satisfies Record<AiFlowStepType, { label: string; tint: string; colour: string; ink: string; icon: typeof User }>;

export const DIAGRAM_SHAPE_ICONS = {
  user: { label: 'Person', icon: User }, 'user-admin': { label: 'Steward', icon: UserAdmin },
  bot: { label: 'Bot', icon: Bot }, 'tool-kit': { label: 'Tools', icon: ToolKit },
  'data-base': { label: 'Database', icon: DataBase }, code: { label: 'Code', icon: Code },
  task: { label: 'Task', icon: Task }, document: { label: 'Document', icon: Document },
  folder: { label: 'Folder', icon: Folder }, cloud: { label: 'Cloud', icon: Cloud },
  chat: { label: 'Chat', icon: Chat }, idea: { label: 'Idea', icon: Idea },
  locked: { label: 'Lock', icon: Locked }, 'decision-tree': { label: 'Decision tree', icon: DecisionTree },
  flow: { label: 'Flow', icon: Flow }, rocket: { label: 'Rocket', icon: Rocket },
  checkmark: { label: 'Checkmark', icon: CheckmarkOutline },
} satisfies Record<DiagramIconName, { label: string; icon: CarbonIconType }>;

const HEADER_PRESETS: Record<string, { tint: string; colour: string; ink: string; icon: CarbonIconType; label: string }> = {
  agent: { tint: '#f6f2ff', colour: '#8a3ffc', ink: '#6929c4', icon: Bot, label: 'Bot' },
  human: { tint: '#defbe6', colour: '#24a148', ink: '#0e6027', icon: User, label: 'Person' },
  pipeline: { tint: '#edf5ff', colour: '#0f62fe', ink: '#0043ce', icon: Flow, label: 'Flow' },
};

export interface DiagramRoleLayout {
  type?: AiFlowStepType;
  icon: CarbonIconType | null;
  iconName: string;
  label: string | null;
  tint: string;
  colour: string;
  ink: string;
  tile: Rect;
  title: { x: number; y: number; width: number };
  content: Rect;
}

/** Small or explicitly aligned shapes keep their original text layout and type chip. */
export function diagramRoleLayout(node: DiagramNode, aiFlow = true): DiagramRoleLayout | null {
  const flow = aiFlow ? node.flow : undefined;
  if (!DIAGRAM_ICON_KINDS.includes(node.kind)) return null;
  if (node.icon === undefined && node.header === undefined && (node.kind === 'decision' || node.width < 120 || node.height < 56
    || node.textAlign !== undefined || node.textVerticalAlign !== undefined)) return null;
  const role = flow === undefined ? undefined : DIAGRAM_ROLES[flow.stepType];
  const label = node.header === undefined ? role?.label ?? null : node.header.trim() || null;
  const headerKey = node.header?.trim().toLowerCase();
  const preset = headerKey !== undefined && Object.prototype.hasOwnProperty.call(HEADER_PRESETS, headerKey) ? HEADER_PRESETS[headerKey] : undefined;
  const chosen = node.icon === null ? undefined : node.icon === undefined ? preset ?? role : DIAGRAM_SHAPE_ICONS[node.icon];
  if (chosen === undefined && label === null) return null;
  const colours = preset ?? role;
  const appearance = {
    ...(flow === undefined ? {} : { type: flow.stepType }), icon: chosen?.icon ?? null, iconName: chosen?.label ?? 'None',
    label, tint: colours?.tint ?? '#f4f4f4', colour: colours?.colour ?? '#525252', ink: colours?.ink ?? '#393939',
  };
  if (node.kind === 'decision') {
    const size = chosen === undefined ? 0 : Math.min(20, node.width * 0.2, node.height * 0.22);
    const headingWidth = label === null ? 0 : Math.min(node.width * 0.38, label.length * 5.4);
    const left = node.x + (node.width - size - headingWidth - (label === null ? 0 : 4)) / 2;
    return { ...appearance,
      tile: { x: left, y: node.y + node.height * 0.16, width: size, height: size },
      title: { x: left + size + 4, y: node.y + node.height * 0.27, width: headingWidth },
      content: { x: node.x + node.width * 0.12, y: node.y + node.height * 0.39, width: node.width * 0.76, height: node.height * 0.43 },
    };
  }
  const inset = node.kind === 'terminator' ? Math.min(node.width, node.height) * 0.2 : 0;
  const x = node.x + inset;
  const size = chosen === undefined ? 0 : Math.min(28, node.width * 0.22, node.height * 0.35);
  const padding = 8;
  const gap = 4;
  const headerHeight = label === null ? 0 : 9;
  const headerSpace = label === null ? 0 : headerHeight + gap;
  const contentX = x + padding + (chosen === undefined ? 0 : size + gap);
  const right = node.x + node.width - inset - padding;
  const layout: DiagramRoleLayout = {
    ...appearance,
    tile: { x: x + padding, y: node.y, width: size, height: size },
    title: { x: contentX, y: node.y, width: Math.max(1, right - contentX) },
    content: { x: contentX, y: node.y, width: Math.max(1, right - contentX),
      height: Math.max(node.fontSize, node.height - 2 * padding - headerSpace) },
  };
  const text = diagramTextLayout(node, layout);
  const textHeight = (text.lines.length - 1) * node.fontSize * 1.25 + node.fontSize;
  const blockHeight = headerSpace + textHeight;
  const rowHeight = Math.max(size, blockHeight);
  const rowTop = node.textVerticalAlign === 'top' ? node.y + padding
    : node.textVerticalAlign === 'bottom' ? node.y + node.height - padding - rowHeight
    : node.y + (node.height - rowHeight) / 2;
  const textTop = rowTop + (rowHeight - blockHeight) / 2;
  layout.title.y = textTop + headerHeight / 2;
  layout.tile.y = rowTop + (rowHeight - size) / 2;
  layout.content.y = textTop + headerSpace;
  layout.content.height = textHeight;
  return layout;
}

export function DiagramRoleBadge({ layout }: { layout: DiagramRoleLayout }): React.ReactElement {
  const Icon = layout.icon;
  const size = layout.tile.width * 22 / 28;
  const padding = (layout.tile.width - size) / 2;
  return <g className="dg-role" data-diagram-role={layout.type} data-diagram-icon={layout.iconName}
    data-ai-chip={layout.label === null ? undefined : 'type'} pointerEvents="none">
    <title>{layout.label === null ? layout.iconName : `${layout.label}: ${layout.iconName}`}</title>
    {Icon !== null && <><rect {...layout.tile} rx={Math.min(8, layout.tile.width / 3)} fill={layout.tint} />
    <g transform={`translate(${layout.tile.x + padding} ${layout.tile.y + padding})`}>
      <Icon size={size} fill={layout.colour} aria-hidden="true" />
    </g></>}
    {layout.label !== null && <text x={layout.title.x} y={layout.title.y} textAnchor="start" fill={layout.ink} fontFamily="'IBM Plex Sans', system-ui, sans-serif"
      fontSize={9} fontWeight={600} letterSpacing="0.08em" dominantBaseline="central">{wrapText(layout.label.toUpperCase(), layout.title.width, 9.8, 1)[0]}</text>}
  </g>;
}
