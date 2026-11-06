export type VisualTone = 'teal' | 'blue' | 'purple' | 'neutral' | 'warning' | 'success';
export type VisualIcon = '' | 'person' | 'worker' | 'document' | 'check' | 'system' | 'arrow' | 'boundary' | 'clock' | 'quality' | 'coin' | 'gauge';
/** Trusted vector illustrations drawn by the renderer; the model chooses an id, never markup. */
export type VisualAsset = 'foundation' | 'workforce-pair' | 'copilot' | 'agent' | 'automation' | 'system' | 'owner'
  | 'outcome' | 'boundary' | 'layers' | 'process' | 'plan';
/** Visual weight of a panel, icon or asset: hero is the one focal subject, secondary supports it. */
export type VisualRole = 'hero' | 'primary' | 'secondary';
export type VisualPort = 'top' | 'right' | 'bottom' | 'left';
export type VisualVideoMode = 'guide' | 'camera' | 'off';
export interface VisualVideoState {
  mode: VisualVideoMode;
  status: 'idle' | 'waiting' | 'requesting' | 'active' | 'error';
  error: string | null;
  requestId: string;
}
/**
 * A change to a node once `at` items have been revealed. States accumulate in order and are recomputed from the
 * reveal count, so seeking backwards restores earlier states. x/y are the node's new top-left corner and scale
 * grows or shrinks it about its centre.
 */
export interface VisualNodeState {
  at: number;
  x?: number; y?: number;
  scale?: number;
  opacity?: number;
  /** Draws a tone ring around a panel, icon or asset. */
  focus?: boolean;
}
export interface VisualNode {
  id: string;
  kind: 'panel' | 'text' | 'icon' | 'image' | 'asset';
  /** Required for, and only valid on, asset nodes. */
  asset?: VisualAsset;
  role?: VisualRole;
  states?: VisualNodeState[];
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
  /** Lays the composition out around the presenter video at full size instead of shrinking it. */
  frame?: 'around-presenter';
  nodes: VisualNode[];
  links: VisualLink[];
}
