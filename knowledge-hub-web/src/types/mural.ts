export interface MuralPoint { x: number; y: number }
export interface MuralObject {
  id: string;
  type: 'shape' | 'textbox' | 'area' | 'image';
  shape: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  parentId: string | null;
  fill: string;
  stroke: string;
  strokeWidth: number;
  dotted: boolean;
  textColor: string;
  fontSize: number;
  align: 'left' | 'center' | 'right';
  image?: string;
  instruction?: string;
  rotation?: number;
}
export interface MuralConnector {
  id: string;
  sourceId: string | null;
  targetId: string | null;
  points: MuralPoint[];
  route: 'straight' | 'orthogonal';
  arrows: 'none' | 'start' | 'end' | 'both';
  stroke: string;
  strokeWidth: number;
  dashed: boolean;
  text: string;
  fontSize: number;
  label: MuralPoint;
}
export interface MuralDiagramExport {
  boardUrl: string;
  title: string;
  objects: MuralObject[];
  connectors: MuralConnector[];
}
