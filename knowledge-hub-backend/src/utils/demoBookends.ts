/**
 * Intro and exit pages for a solution demo: the script visuals' opening title and end page, without a script.
 * Athena's approved wording travels in her chat reply as a fenced block that the chat renders as two slides.
 */
export interface DemoBookends {
  intro: { label: string; title: string; subtitle: string };
  exit: { setup: string; statement: string };
}

export const DEMO_BOOKENDS_FENCE = 'athena-demo-bookends';

const LIMITS = {
  label: { field: 'intro_label', max: 4, required: false },
  title: { field: 'intro_title', max: 8, required: true },
  subtitle: { field: 'intro_subtitle', max: 20, required: false },
  setup: { field: 'exit_setup', max: 10, required: false },
  statement: { field: 'exit_statement', max: 8, required: true },
} as const;

function text(value: unknown, limit: { field: string; max: number; required: boolean }): string {
  const clean = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (clean === '' && limit.required) throw new Error(`${limit.field} is required.`);
  if (/thank you/i.test(clean)) throw new Error(`${limit.field} must not say "Thank you"; the end page adds it.`);
  const words = clean === '' ? 0 : clean.split(' ').length;
  if (words > limit.max) throw new Error(`${limit.field} has ${words} words; at most ${limit.max}.`);
  return clean;
}

/** Validates tool arguments (snake_case) into bookends, throwing a message Athena can act on. */
export function demoBookendsFromArgs(args: Record<string, unknown>): DemoBookends {
  return {
    intro: { label: text(args['intro_label'], LIMITS.label), title: text(args['intro_title'], LIMITS.title), subtitle: text(args['intro_subtitle'], LIMITS.subtitle) },
    exit: { setup: text(args['exit_setup'], LIMITS.setup), statement: text(args['exit_statement'], LIMITS.statement) },
  };
}

export function demoBookendsBlock(bookends: DemoBookends): string {
  return `\`\`\`${DEMO_BOOKENDS_FENCE}\n${JSON.stringify(bookends)}\n\`\`\``;
}

function parse(json: string): DemoBookends | null {
  try {
    const value = JSON.parse(json) as { intro?: Record<string, unknown>; exit?: Record<string, unknown> };
    return demoBookendsFromArgs({
      intro_label: value.intro?.['label'], intro_title: value.intro?.['title'], intro_subtitle: value.intro?.['subtitle'],
      exit_setup: value.exit?.['setup'], exit_statement: value.exit?.['statement'],
    });
  } catch {
    return null;
  }
}

/** Separates rendered bookends from the reply text; malformed blocks stay in the text as they were. */
export function splitDemoBookends(content: string): { text: string; bookends: DemoBookends[] } {
  const bookends: DemoBookends[] = [];
  const pattern = new RegExp('```' + DEMO_BOOKENDS_FENCE + '\\s*\\n([\\s\\S]*?)\\n```', 'g');
  const remaining = content.replace(pattern, (block, json: string) => {
    const parsed = parse(json);
    if (parsed === null) return block;
    bookends.push(parsed);
    return '';
  });
  return { text: bookends.length > 0 ? remaining.replace(/\n{3,}/g, '\n\n').trim() : content, bookends };
}
