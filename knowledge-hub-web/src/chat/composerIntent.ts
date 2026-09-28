/**
 * composerIntent — parsing and inference for the Athena chat composer.
 *
 * Deliberately free of React/DOM so it can be unit-tested in isolation once a
 * test harness exists. The UI renders from the derived `effective*` fields and
 * keeps no duplicated chip state of its own.
 *
 * IMPORTANT: `action` here is PER-MESSAGE. It is not the same thing as, and
 * must never be folded into, `AthenaPersona` — which is thread-scoped,
 * server-persisted, and drives system-prompt and model routing on the backend.
 */

export type ComposerAction = 'draft' | 'critique' | 'code' | 'task' | 'note';

export interface ComposerProject {
  id: string;
  name: string;
}

export interface ComposerIntent {
  /** Input text with any recognised command/mention syntax removed. */
  rawText: string;
  explicitAction?: ComposerAction;
  inferredAction?: ComposerAction;
  effectiveAction?: ComposerAction;
  explicitProjectId?: string;
  inferredProjectId?: string;
  effectiveProjectId?: string;
}

interface BuildIntentOptions {
  input: string;
  projects: ComposerProject[];
  /** Conversation-level grounding already persisted for this session. */
  activeProjectId: string;
  /**
   * Chip-level override. `'none'` means the user explicitly cleared the action
   * chip; `null` means no override, so parsing/inference decides.
   */
  actionOverride?: ComposerAction | 'none' | null;
}

export const COMPOSER_ACTIONS: ComposerAction[] = ['draft', 'critique', 'code', 'task', 'note'];

export const COMPOSER_ACTION_LABELS: Record<ComposerAction, string> = {
  draft: 'Draft',
  critique: 'Critique',
  code: 'Code',
  task: 'Task',
  note: 'Note',
};

/**
 * Appended to the outgoing message so the model actually honours the chosen
 * action. Kept short and human-readable because it is echoed into the chat
 * transcript verbatim — the local echo and the persisted server history must
 * stay identical, otherwise a reload would show different text.
 */
const ACTION_DIRECTIVES: Record<ComposerAction, string> = {
  draft: 'produce a written draft as the primary output',
  critique: 'critique this — challenge the thinking and surface weak points, risks and gaps rather than agreeing',
  code: 'answer with working code plus a brief explanation',
  task: 'treat this as an actionable task to capture',
  note: 'treat this as material to capture as a Think note',
};

/** Ordered most-specific first — the first pattern to match wins. */
const ACTION_PATTERNS: Array<{ action: ComposerAction; pattern: RegExp }> = [
  { action: 'task', pattern: /\b(add a task|action item|to-?do|remind me to|task board|taskboard)\b/i },
  { action: 'critique', pattern: /\b(critique|poke holes|tear apart|sanity check|challenge this|weak points|feedback on)\b/i },
  { action: 'code', pattern: /\b(refactor|stack trace|typescript|javascript|regex|compile error|unit test|this function|code sample)\b/i },
  { action: 'note', pattern: /\b(think note|jot down|capture this|save this as a note|make a note)\b/i },
  { action: 'draft', pattern: /\b(draft|write (me )?(a|an|the)|blog post|newsletter|article|outline)\b/i },
];

const SLASH_COMMAND_RE = /^\/([a-z]+)(?=\s|$)/i;
const MENTION_RE = /(^|\s)@([a-z0-9][a-z0-9-]*)/gi;

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function isComposerAction(value: string): value is ComposerAction {
  return (COMPOSER_ACTIONS as string[]).includes(value);
}

/**
 * Resolves an `@token` against the real project list. Matches a project id or a
 * slugified project name, exactly or by prefix (so `@imagine` finds "Imagine
 * Claims"). An unresolved token is left alone by the caller.
 */
function resolveProject(token: string, projects: ComposerProject[]): ComposerProject | undefined {
  const needle = slugify(token);
  if (needle === '') return undefined;
  const exact = projects.find((p) => slugify(p.id) === needle || slugify(p.name) === needle);
  if (exact !== undefined) return exact;
  return projects.find((p) => slugify(p.id).startsWith(needle) || slugify(p.name).startsWith(needle));
}

/**
 * Conservative project inference: only fires when a project's full name appears
 * as a phrase in the message. Short names are ignored to avoid false positives
 * on common words.
 */
function inferProject(text: string, projects: ComposerProject[]): ComposerProject | undefined {
  const haystack = text.toLowerCase();
  return projects.find((p) => p.name.length >= 5 && haystack.includes(p.name.toLowerCase()));
}

function inferAction(text: string): ComposerAction | undefined {
  return ACTION_PATTERNS.find(({ pattern }) => pattern.test(text))?.action;
}

/**
 * Removes every resolved `@project` mention from the input. Used when the user
 * picks a project from the chip directly — the chip is the more recent explicit
 * act, so the stale mention is cleared rather than silently overriding it.
 * Unresolved tokens are left untouched.
 */
export function stripProjectMentions(input: string, projects: ComposerProject[]): string {
  return input
    .replace(MENTION_RE, (match: string, lead: string, token: string) =>
      (resolveProject(token, projects) === undefined ? match : lead))
    .replace(/[ \t]{2,}/g, ' ')
    .trimEnd();
}

export function buildComposerIntent(options: BuildIntentOptions): ComposerIntent {
  const { input, projects, activeProjectId, actionOverride = null } = options;

  let working = input;
  let explicitAction: ComposerAction | undefined;

  // Slash commands are only recognised at the very start of the input. An
  // unrecognised `/word` is deliberately left as literal text so nothing the
  // user typed is ever destroyed.
  const slashMatch = SLASH_COMMAND_RE.exec(working);
  const slashWord = slashMatch?.[1];
  if (slashMatch !== null && slashWord !== undefined) {
    const candidate = slashWord.toLowerCase();
    if (isComposerAction(candidate)) {
      explicitAction = candidate;
      working = working.slice(slashMatch[0].length).replace(/^\s+/, '');
    }
  }

  // Resolve mentions in document order, then strip only the first one that
  // actually maps to a project. Unresolved tokens stay as literal text.
  let explicitProject: ComposerProject | undefined;
  for (const match of Array.from(working.matchAll(MENTION_RE))) {
    const token = match[2];
    if (token === undefined) continue;
    const project = resolveProject(token, projects);
    if (project === undefined) continue;
    explicitProject = project;
    const lead = match[1] ?? '';
    working = working.slice(0, match.index) + lead + working.slice(match.index + match[0].length);
    break;
  }

  const rawText = working.trim();
  const inferredAction = inferAction(rawText);
  const inferredProject = activeProjectId === '' ? inferProject(rawText, projects) : undefined;

  const chosenAction = actionOverride === 'none'
    ? undefined
    : actionOverride ?? explicitAction ?? inferredAction;

  const explicitProjectId = explicitProject?.id;
  const effectiveProjectId = explicitProjectId ?? (activeProjectId !== '' ? activeProjectId : inferredProject?.id);

  return {
    rawText,
    ...(explicitAction !== undefined && { explicitAction }),
    ...(inferredAction !== undefined && { inferredAction }),
    ...(chosenAction !== undefined && { effectiveAction: chosenAction }),
    ...(explicitProjectId !== undefined && { explicitProjectId }),
    ...(inferredProject !== undefined && { inferredProjectId: inferredProject.id }),
    ...(effectiveProjectId !== undefined && effectiveProjectId !== '' && { effectiveProjectId }),
  };
}

/**
 * Composes the text actually sent for a turn. The chat transcript echoes this
 * exact string, so what the user sees locally always matches what a reload
 * replays from the server.
 */
export function composeMessageText(text: string, action: ComposerAction | undefined): string {
  if (action === undefined || text === '') return text;
  return `${text}\n\n(Requested action — ${action}: ${ACTION_DIRECTIVES[action]}.)`;
}
