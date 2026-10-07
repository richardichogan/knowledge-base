// Editor-only contrast adjustments; saved colours and exports stay unchanged.
const DARK_INK: Record<string, string> = {
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
