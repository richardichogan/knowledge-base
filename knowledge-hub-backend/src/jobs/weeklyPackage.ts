import { marked } from 'marked';
import { ValidationError } from '../types/errors.js';

const FIELDS = {
  title: 'Title', slug: 'Slug', featuredImageUrl: 'Featured image URL', imagePrompt: 'Image prompt',
  bodyMarkdown: 'Content', excerpt: 'Excerpt', summary: 'Summary TL;DR', keyTakeaways: 'Key takeaways',
  categories: 'Categories', tags: 'Tags', linkedin: 'LinkedIn post', twitterCopy: 'Twitter/X post',
} as const;

/** Parse the writer's CMS package once; never ask another model to rewrite it as JSON. */
export function parseWeeklyPackage(markdown: string): Record<string, unknown> {
  const sections = new Map<string, string>();
  for (const match of markdown.matchAll(/^## ([^\r\n]+)\r?\n([\s\S]*?)(?=^## |(?![\s\S]))/gm)) {
    const [, rawHeading, rawBody] = match;
    const heading = rawHeading!.trim();
    if (sections.has(heading)) throw new ValidationError(`Weekly package repeats ${heading}.`);
    sections.set(heading, rawBody!.trim());
  }
  const result: Record<string, unknown> = { postType: 'weekly', status: 'published' };
  for (const [field, heading] of Object.entries(FIELDS)) {
    const value = sections.get(heading);
    if (!value) throw new ValidationError(`Weekly package is incomplete: missing ${heading}.`);
    result[field] = field === 'categories' || field === 'tags'
      ? value.split(',').map(item => item.trim()).filter(Boolean)
      : field === 'keyTakeaways'
        ? value.split(/\r?\n\s*\r?\n/).map(item => item.trim()).filter(Boolean)
        : value;
  }
  return materializeWeeklyPackage(result);
}

/** Markdown is canonical; HTML and the saved CMS view are derived, never separately edited. */
export function materializeWeeklyPackage(value: Record<string, unknown>): Record<string, unknown> {
  if (typeof value.bodyMarkdown !== 'string' || !value.bodyMarkdown.trim()) {
    throw new ValidationError('Weekly package has no article Markdown.');
  }
  const sections = Object.entries(FIELDS).map(([field, heading]) => {
    const item = value[field];
    if (typeof item !== 'string' && !(Array.isArray(item) && item.every(entry => typeof entry === 'string'))) {
      throw new ValidationError(`Weekly package has an invalid ${heading}.`);
    }
    const rendered = Array.isArray(item) ? item.join(field === 'keyTakeaways' ? '\n\n' : ', ') : item;
    if (!rendered.trim()) throw new ValidationError(`Weekly package is incomplete: missing ${heading}.`);
    return `## ${heading}\n${rendered}`;
  });
  return { ...value, content: marked.parse(value.bodyMarkdown, { async: false }),
    markdown: `# ${String(value.title)}\n\n${sections.join('\n\n')}` };
}
