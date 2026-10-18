/**
 * Athena identity palette — one colour vocabulary for projects, theme areas and
 * filing tags. Keys are stored on projects; hex values are denormalised onto tags.
 * Keep in sync with knowledge-hub-web/src/identity/palette.ts.
 */
export const IDENTITY_PALETTE = {
  blue:        '#78a9ff',
  cyan:        '#33b1ff',
  teal:        '#3ddbd9',
  green:       '#6fdc8c',
  lime:        '#b6d65c',
  yellow:      '#f1c21b',
  orange:      '#ff9f5a',
  red:         '#ff8389',
  magenta:     '#ff7eb6',
  purple:      '#be95ff',
  indigo:      '#a0a4ff',
  'warm-gray': '#bab0ac',
  gray:        '#a8a8a8',
} as const;

export type IdentityColour = keyof typeof IDENTITY_PALETTE;

export const IDENTITY_COLOURS = Object.keys(IDENTITY_PALETTE) as IdentityColour[];

export function isIdentityColour(value: unknown): value is IdentityColour {
  return typeof value === 'string' && value in IDENTITY_PALETTE;
}
