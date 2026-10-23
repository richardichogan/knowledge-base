// Editor-only contrast adjustments; saved colours and exports stay unchanged.
// The sheet is light grey, so colours authored for the old dark sheet map to
// their light equivalents and everything else displays as authored.
const LIGHT_FILLS: Record<string, string> = {
  '#262626': '#ffffff', '#1c2d4a': '#a6c8ff', '#173b27': '#6fdc8c', '#3d3215': '#f1c21b',
  '#442027': '#ffb3b8', '#302342': '#d4bbff', '#202020': '#f4f4f4',
  '#0f3433': '#3ddbd9', '#3e1a2b': '#ffafd2',
  '#012749': '#82cfff', '#3e1a00': '#ffb784',
  '#edf5ff': '#a6c8ff', '#f6f2ff': '#d4bbff', '#e5f6ff': '#82cfff',
  '#d9fbfb': '#3ddbd9', '#defbe6': '#6fdc8c', '#fff0f7': '#ffafd2',
  '#fff1f1': '#ffb3b8', '#fcf4d6': '#f1c21b', '#fff2e8': '#ffb784',
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
