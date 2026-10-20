export function browserWidths(mode) {
  if (mode === 'panel-typography' || mode === 'mural') return [1440, 768, 390];
  return mode === 'chat' ? [390] : [1440];
}
