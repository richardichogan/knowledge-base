export function browserWidths(mode) {
  if (mode === 'panel-typography') return [1440, 768, 390];
  return mode === 'chat' ? [390] : [1440];
}
