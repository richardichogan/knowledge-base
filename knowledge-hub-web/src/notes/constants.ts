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
  | 'spec';

export interface ContentTypeOption {
  id: ContentType;
  label: string;
}

export const CONTENT_TYPE_OPTIONS: ContentTypeOption[] = [
  { id: 'blog',                label: 'Blog draft' },
  { id: 'podcast',              label: 'Podcast script' },
  { id: 'podcast-show-notes',   label: 'Podcast show notes' },
  { id: 'newsletter',           label: 'Newsletter edition' },
  { id: 'project',              label: 'Project note' },
  { id: 'note',                 label: 'General note' },
  { id: 'script',               label: 'Script' },
  { id: 'architecture',         label: 'Architecture doc' },
  { id: 'meeting',              label: 'Meeting notes / transcript' },
  { id: 'research',             label: 'Research brief' },
  { id: 'spec',                 label: 'Technical spec' },
];

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
};

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
