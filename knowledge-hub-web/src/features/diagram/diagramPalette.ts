/** A compact subset of the IBM Carbon palette, with legacy diagram colours retained. */
export const IBM_COLOURS: Readonly<Record<string, string>> = {
  '#a6c8ff': 'IBM Blue 30', '#d4bbff': 'IBM Purple 30', '#82cfff': 'IBM Cyan 30',
  '#3ddbd9': 'IBM Teal 30', '#6fdc8c': 'IBM Green 30', '#ffafd2': 'IBM Magenta 30',
  '#ffb3b8': 'IBM Red 30', '#ffb784': 'IBM Orange 30', '#e0e0e0': 'IBM Gray 20',
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
  '#ffffff', '#e0e0e0', 'none',
  '#a6c8ff', '#d4bbff', '#82cfff', '#3ddbd9', '#6fdc8c', '#ffafd2', '#ffb3b8', '#f1c21b', '#ffb784',
];
export const DIAGRAM_STROKES = ['#161616', '#525252', '#0f62fe', '#198038', '#b28600', '#da1e28', '#8a3ffc', '#1192e8', '#007d79', '#d02670', '#f1c21b', '#eb6200', 'none'];
export const DIAGRAM_TEXT_COLOURS = ['#161616', '#525252', '#ffffff', ...DIAGRAM_STROKES.filter(colour => !['#161616', '#525252', 'none'].includes(colour))];
