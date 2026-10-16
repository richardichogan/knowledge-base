/** A compact subset of the IBM Carbon palette, with legacy diagram colours retained. */
export const IBM_COLOURS: Readonly<Record<string, string>> = {
  '#edf5ff': 'IBM Blue 10', '#0f62fe': 'IBM Blue 60',
  '#f6f2ff': 'IBM Purple 10', '#8a3ffc': 'IBM Purple 60',
  '#e5f6ff': 'IBM Cyan 10', '#1192e8': 'IBM Cyan 50',
  '#d9fbfb': 'IBM Teal 10', '#007d79': 'IBM Teal 60',
  '#defbe6': 'IBM Green 10', '#198038': 'IBM Green 60',
  '#fff0f7': 'IBM Magenta 10', '#d02670': 'IBM Magenta 60',
  '#fff1f1': 'IBM Red 10', '#da1e28': 'IBM Red 60',
  '#fcf4d6': 'IBM Yellow 10', '#f1c21b': 'IBM Yellow 30',
  '#fff2e8': 'IBM Orange 10', '#eb6200': 'IBM Orange 50',
  '#ffffff': 'White', '#161616': 'IBM Gray 100', '#525252': 'IBM Gray 70',
};
export const DIAGRAM_FILLS = [
  '#262626', '#1c2d4a', '#173b27', '#3d3215', 'none',
  '#edf5ff', '#f6f2ff', '#e5f6ff', '#d9fbfb', '#defbe6', '#fff0f7', '#fff1f1', '#fcf4d6', '#fff2e8',
];
export const DIAGRAM_STROKES = ['#161616', '#525252', '#0f62fe', '#198038', '#b28600', '#da1e28', '#8a3ffc', '#1192e8', '#007d79', '#d02670', '#f1c21b', '#eb6200', 'none'];
export const DIAGRAM_TEXT_COLOURS = ['#161616', '#525252', '#ffffff', ...DIAGRAM_STROKES.filter(colour => !['#161616', '#525252', 'none'].includes(colour))];
