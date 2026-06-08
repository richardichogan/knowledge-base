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
  spark:           'thinking',
  commit:          'output',
  pull_request:    'output',
  blog_post:       'output',
  podcast_episode: 'output',
  document:        'reference',
  canvas:          'reference',
  task:            'task',
};

/** One colour per concept-area parent. */
export const CONCEPT_COLOUR: Record<string, string> = {
  'Microsoft Cloud':         '#82cfff',
  'AI':                      '#be95ff',
  'Security and Identity':   '#fa4d56',
  'DevOps and Automation':   '#6fdc8c',
  'Architecture and Method': '#ffb784',
  'Observability and Data':  '#3ddbd9',
  'Industry':                '#f1c21b',
};

/** Colour for nodes with no concept-area parent. */
export const NO_CONCEPT_COLOUR = '#6f6f6f';

/**
 * Returns the fill colour for a node given the active colour mode.
 * @param refType      - Node content type (e.g. 'note', 'spark').
 * @param conceptParent - Dominant concept-area parent name, or null.
 * @param mode         - Active colour mode.
 */
export function nodeColour(
  refType: string,
  conceptParent: string | null,
  mode: ColourMode,
): string {
  if (mode === 'concept') {
    return conceptParent ? (CONCEPT_COLOUR[conceptParent] ?? NO_CONCEPT_COLOUR) : NO_CONCEPT_COLOUR;
  }
  const family = TYPE_TO_FAMILY[refType];
  return family ? FAMILY_COLOUR[family] : '#8d8d8d';
}
