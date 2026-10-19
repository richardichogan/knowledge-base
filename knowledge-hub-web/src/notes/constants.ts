/**
 * notes/constants.ts — string constants and option lists for the Notes feature.
 */

export const AUTOSAVE_INTERVAL_MS = 5 * 60_000; // 5 minutes
export const SAVED_BANNER_DURATION_MS = 2_000;

export const UNTITLED_DOCUMENT = 'Untitled';

// ── Content type options ──────────────────────────────────────────────────────

export type ContentType =
  | 'blog'
  | 'podcast'
  | 'podcast-show-notes'
  | 'newsletter'
  | 'project'
  | 'note'
  | 'script'
  | 'architecture'
  | 'meeting'
  | 'research'
  | 'spec'
  | 'use-case';

export type ContentTypeGroup = 'Work' | 'Publishing' | 'Thinking';

export interface ContentTypeOption {
  id: ContentType;
  label: string;
  group: ContentTypeGroup;
}

/** Stored ids never change — other features key off them. Only labels and grouping are presentational. */
export const CONTENT_TYPE_OPTIONS: ContentTypeOption[] = [
  { id: 'meeting',              label: 'Meeting notes',      group: 'Work' },
  { id: 'project',              label: 'Project note',       group: 'Work' },
  { id: 'use-case',             label: 'Use case',           group: 'Work' },
  { id: 'spec',                 label: 'Technical spec',     group: 'Work' },
  { id: 'architecture',         label: 'Architecture doc',   group: 'Work' },
  { id: 'blog',                 label: 'Blog draft',         group: 'Publishing' },
  { id: 'newsletter',           label: 'Newsletter edition', group: 'Publishing' },
  { id: 'podcast',              label: 'Podcast script',     group: 'Publishing' },
  { id: 'podcast-show-notes',   label: 'Podcast show notes', group: 'Publishing' },
  { id: 'script',               label: 'Script',             group: 'Publishing' },
  { id: 'note',                 label: 'General note',       group: 'Thinking' },
  { id: 'research',             label: 'Research brief',     group: 'Thinking' },
];

export const CONTENT_TYPE_GROUPS: { label: ContentTypeGroup; options: ContentTypeOption[] }[] =
  (['Work', 'Publishing', 'Thinking'] as const).map((label) => ({
    label,
    options: CONTENT_TYPE_OPTIONS.filter((option) => option.group === label),
  }));

// ── Tag type per content type ─────────────────────────────────────────────────

export const CONTENT_TYPE_TAG: Record<ContentType, 'green' | 'teal' | 'purple' | 'blue' | 'gray' | 'red' | 'cyan' | 'magenta' | 'orange'> = {
  blog:                'green',
  podcast:             'teal',
  'podcast-show-notes': 'purple',
  newsletter:          'purple',
  project:             'blue',
  note:                'gray',
  script:              'red',
  architecture:        'blue',
  meeting:             'orange',
  research:            'cyan',
  spec:                'magenta',
  'use-case':          'teal',
};

// ── Use case template ─────────────────────────────────────────────────────────

/**
 * Skeleton inserted when an empty note is switched to the "Use case" content
 * type. Use cases are captured as free-form prose under a fixed set of
 * headings rather than structured fields, so the whole note stays searchable
 * and Athena can compare across the library without a bespoke schema. The
 * headings exist to make the comparison possible — they're the questions a
 * client actually asks (commercial shape, document dependencies, deployment)
 * as much as the narrative itself.
 */
export const USE_CASE_TEMPLATE_HEADINGS: string[] = [
  'Summary',
  'Client & vertical context',
  'Personas',
  'Trigger & problem',
  'Narrative walkthrough',
  'Agents & orchestration',
  'Guardrails and human-in-the-loop',
  'Data & document dependencies (native vs converted)',
  'Value & measurement (forecast vs booked)',
  'Deployment considerations',
  'Commercial shape',
  'Open questions & risks',
  'Related assets',
];

// ── BlockNote g100 theme override ─────────────────────────────────────────────

export const BLOCKNOTE_G100_THEME = {
  colors: {
    editor:   { text: '#f4f4f4', background: '#161616' },  // $text-primary / $background
    menu:     { text: '#f4f4f4', background: '#262626' },  // $layer-01
    tooltip:  { text: '#c6c6c6', background: '#393939' },  // $text-secondary / $layer-02
    hovered:  { text: '#f4f4f4', background: '#353535' },  // $layer-hover-01
    selected: { text: '#f4f4f4', background: '#0f62fe' },  // $interactive
    disabled: { text: '#6f6f6f', background: '#262626' },  // $text-disabled
    shadow:   'rgba(0,0,0,0.5)',
    border:   '#393939',                                    // $border-subtle-01
    sideMenu: '#6f6f6f',
  },
  borderRadius: 2,
  fontFamily: "'IBM Plex Sans', 'Helvetica Neue', Arial, sans-serif",
} as const;

// ── GitHub modal strings ──────────────────────────────────────────────────────

export const GITHUB_MODAL_HEADING = 'Push to GitHub';
export const GITHUB_MODAL_LABEL = 'Confirm push';
export const GITHUB_COMMIT_PLACEHOLDER = 'Add note: <title>';
