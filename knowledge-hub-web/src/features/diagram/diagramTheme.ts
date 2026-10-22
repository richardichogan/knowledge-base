// Editor-only contrast adjustments; saved colours and exports stay unchanged.
// The sheet is light grey, so colours authored for the old dark sheet map to
// their light equivalents and everything else displays as authored.
const LIGHT_FILLS: Record<string, string> = {
  '#262626': '#ffffff', '#1c2d4a': '#edf5ff', '#173b27': '#defbe6', '#3d3215': '#fcf4d6',
  '#442027': '#fff1f1', '#302342': '#f6f2ff', '#202020': '#f4f4f4',
  '#0f3433': '#d9fbfb', '#3e1a2b': '#fff0f7',
  '#012749': '#e5f6ff', '#3e1a00': '#fff2e8',
};
const LIGHT_INK: Record<string, string> = {
  '#f4f4f4': '#161616', '#fff': '#161616', '#ffffff': '#161616', white: '#161616',
  '#c6c6c6': '#525252',
  '#78a9ff': '#0f62fe',
  '#6fdc8c': '#198038',
  '#f1c21b': '#b28600',
  '#ff8389': '#da1e28',
  '#be95ff': '#8a3ffc',
  '#3ddbd9': '#007d79',
  '#ff7eb6': '#d02670',
  '#a8a8a8': '#6f6f6f',
  '#82cfff': '#1192e8',
  '#ffb784': '#eb6200',
};

export function diagramEditorInk(colour: string): string {
  return LIGHT_INK[colour.toLowerCase()] ?? colour;
}

export function diagramEditorFill(colour: string): string {
  return LIGHT_FILLS[colour.toLowerCase()] ?? colour;
}

export function diagramEditorNodeColours(node: { fill: string; stroke: string; textColor: string }): {
  fill: string; stroke: string; textColor: string;
} {
  const fill = diagramEditorFill(node.fill);
  const darkAuthored = fill !== node.fill || fill === 'none' || fill === 'transparent';
  return { fill, stroke: darkAuthored ? diagramEditorInk(node.stroke) : node.stroke,
    textColor: darkAuthored ? diagramEditorInk(node.textColor) : node.textColor };
}
