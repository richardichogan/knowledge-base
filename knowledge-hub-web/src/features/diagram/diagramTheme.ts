// Editor-only contrast adjustments; saved colours and exports stay unchanged.
const DARK_FILLS: Record<string, string> = {
  '#fff': '#262626', '#ffffff': '#262626', white: '#262626',
  '#edf5ff': '#1c2d4a', '#defbe6': '#173b27', '#fcf4d6': '#3d3215',
  '#fff1f1': '#442027', '#f6f2ff': '#302342', '#f4f4f4': '#202020',
};
const DARK_INK: Record<string, string> = {
  '#000': '#f4f4f4', '#000000': '#f4f4f4', black: '#f4f4f4',
  '#111111': '#f4f4f4',
  '#161616': '#f4f4f4',
  '#333333': '#c6c6c6',
  '#525252': '#c6c6c6',
  '#0f62fe': '#78a9ff',
  '#198038': '#6fdc8c',
  '#b28600': '#f1c21b',
  '#da1e28': '#ff8389',
  '#8a3ffc': '#be95ff',
};

export function diagramEditorInk(colour: string): string {
  return DARK_INK[colour.toLowerCase()] ?? colour;
}

export function diagramEditorFill(colour: string): string {
  return DARK_FILLS[colour.toLowerCase()] ?? colour;
}

export function diagramEditorNodeColours(node: { fill: string; stroke: string; textColor: string }): {
  fill: string; stroke: string; textColor: string;
} {
  const fill = diagramEditorFill(node.fill);
  const darkSurface = fill !== node.fill || fill === 'none' || fill === 'transparent'
    || Object.values(DARK_FILLS).includes(fill.toLowerCase());
  return { fill, stroke: darkSurface ? diagramEditorInk(node.stroke) : node.stroke,
    textColor: darkSurface ? diagramEditorInk(node.textColor) : node.textColor };
}
