/**
 * Athena identity palette — one colour vocabulary for projects, theme areas and topics.
 * Colour means theme; an icon means a project or a content type.
 * Keep in sync with knowledge-hub-backend/src/services/identityPalette.ts.
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

export const COLOUR_LABEL: Record<IdentityColour, string> = {
  blue: 'Blue', cyan: 'Cyan', teal: 'Teal', green: 'Green', lime: 'Lime', yellow: 'Yellow',
  orange: 'Orange', red: 'Red', magenta: 'Magenta', purple: 'Purple', indigo: 'Indigo',
  'warm-gray': 'Warm grey', gray: 'Grey',
};

/** Colour for anything that has no theme (groups, untagged nodes). */
export const NEUTRAL_HEX = '#8d8d8d';

export function colourHex(key: string | null | undefined): string {
  return key != null && key in IDENTITY_PALETTE ? IDENTITY_PALETTE[key as IdentityColour] : NEUTRAL_HEX;
}
