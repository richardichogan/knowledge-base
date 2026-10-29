/**
 * graph/graphColour.ts
 * Colour resolution for graph nodes.
 * Two modes: 'type' (family-based) and 'concept' (concept-area parent).
 */

export type ColourMode = 'type' | 'concept';

/** Five clearly-separable hue families, one per content-type group. */
export const FAMILY_COLOUR = {
  inbound:   '#82cfff',
  thinking:  '#ff7eb6',
  output:    '#be95ff',
  reference: '#6fdc8c',
  task:      '#ffb784',
} as const;

type Family = keyof typeof FAMILY_COLOUR;

/** Maps every ref_type to its family. */
export const TYPE_TO_FAMILY: Record<string, Family> = {
  discover_item:   'inbound',
  cfp_item:        'inbound',
  note:            'thinking',
  tag:             'thinking',
  spark:           'thinking',
  commit:          'output',
  pull_request:    'output',
  issue:           'task',
  github_item:     'output',
  blog_post:       'output',
  podcast_episode: 'output',
  document:        'reference',
  canvas:          'reference',
  task:            'task',
  project:         'reference',
  company:         'output',
  person:          'inbound',
  decision:        'thinking',
  risk:            'task',
  chat:            'thinking',
};

/** Colour for nodes with no concept-area parent. */
export const NO_CONCEPT_COLOUR = '#6f6f6f';

/** Resolves a concept-area name to its theme colour (from the shared identity index). */
export type AreaColour = (areaName: string) => string | null | undefined;

/**
 * Returns the fill colour for a node given the active colour mode.
 * @param refType      - Node content type (e.g. 'note', 'spark').
 * @param conceptParent - Dominant concept-area parent name, or null.
 * @param mode         - Active colour mode.
 * @param areaColour   - Area name → theme colour, so the graph matches every other tag.
 */
export function nodeColour(
  refType: string,
  conceptParent: string | null,
  mode: ColourMode,
  areaColour?: AreaColour,
): string {
  if (mode === 'concept') {
    return conceptParent ? (areaColour?.(conceptParent) ?? NO_CONCEPT_COLOUR) : NO_CONCEPT_COLOUR;
  }
  const family = TYPE_TO_FAMILY[refType];
  return family ? FAMILY_COLOUR[family] : '#8d8d8d';
}
