export type VisualTone = 'teal' | 'blue' | 'purple' | 'neutral' | 'warning' | 'success';
export type VisualIcon = '' | 'person' | 'worker' | 'document' | 'check' | 'system' | 'arrow' | 'boundary';
export interface VisualNode {
  id: string;
  kind: 'panel' | 'text' | 'icon' | 'image';
  x: number; y: number; width: number; height: number;
  label: string; detail: string;
  tone: VisualTone;
  icon: VisualIcon;
  reveal: number;
}
export interface VisualLink {
  from: string; to: string; label: string;
  tone: VisualTone;
  reveal: number;
  style: 'solid' | 'dashed';
}
export interface VisualComposition {
  label: string;
  imagePrompt: string;
  nodes: VisualNode[];
  links: VisualLink[];
}
