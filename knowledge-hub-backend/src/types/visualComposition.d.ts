export type VisualTone = 'teal' | 'blue' | 'purple' | 'neutral' | 'warning' | 'success';
export type VisualIcon = '' | 'person' | 'worker' | 'document' | 'check' | 'system' | 'arrow' | 'boundary';
export type VisualPort = 'top' | 'right' | 'bottom' | 'left';
export type VisualVideoMode = 'guide' | 'camera' | 'off';
export interface VisualVideoState {
  mode: VisualVideoMode;
  status: 'idle' | 'waiting' | 'requesting' | 'active' | 'error';
  error: string | null;
  requestId: string;
}
export interface VisualNode {
  id: string;
  kind: 'panel' | 'text' | 'icon' | 'image';
  x: number; y: number; width: number; height: number;
  label: string; detail: string;
  tone: VisualTone;
  icon: VisualIcon;
  reveal: number;
  entrance?: 'fade' | 'rise' | 'left' | 'right' | 'scale' | 'wipe';
  emphasis?: 'highlight' | 'underline' | 'strike';
  /** Text-node type scale; defaults to 'm'. */
  size?: 'xl' | 'l' | 'm' | 's';
  /** Short mono uppercase label shown above the node label. */
  kicker?: string;
}
export interface VisualLink {
  from: string; to: string; label: string;
  tone: VisualTone;
  reveal: number;
  style: 'solid' | 'dashed';
  motion?: 'draw' | 'flow';
  route?: 'direct' | 'arc';
  fromPort?: VisualPort;
  toPort?: VisualPort;
}
export interface VisualComposition {
  label: string;
  imagePrompt: string;
  imageTreatment?: 'full' | 'blend';
  nodes: VisualNode[];
  links: VisualLink[];
}
