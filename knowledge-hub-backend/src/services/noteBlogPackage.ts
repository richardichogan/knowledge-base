/**
 * services/noteBlogPackage.ts — turns a Think blog note into publish-ready CMS draft fields.
 *
 * Blog notes are drafted as the CMS output package from blogHouseStyle.ts (numbered bold
 * field labels). This parser is tolerant of formatting drift: optional numbering, heading
 * hashes, bold markers and separator characters. A note without field labels publishes its
 * whole body as the content, titled from the note itself.
 */
import type { Pool } from 'pg';
import { marked } from 'marked';
import { noteMarkdown } from './noteMarkdown.js';
import { parseWriting } from './noteVersionService.js';
import { NotFoundError, ValidationError } from '../types/errors.js';
import { POST_TYPES, type PostType } from '../ai/blogDraft.js';

export interface NoteBlogPackage {
  postType: PostType;
  title: string;
  slug?: string;
  excerpt: string;
  summary: string;
  /** Article body as HTML — drafts and published posts are always sent to the CMS as HTML. */
  content: string;
  keyTakeaways: string[];
  categories: string[];
  tags: string[];
  /** CMS fields the note did not supply; shown as a heads-up, not a blocker here. */
  missing: string[];
}

type FieldKey = 'title' | 'slug' | 'featuredImage' | 'imagePrompt' | 'content' | 'excerpt'
  | 'summary' | 'keyTakeaways' | 'categories' | 'tags' | 'postType' | 'linkedin' | 'twitter';

/** Label patterns in CMS package order; social fields are recognised only so they are excluded. */
const FIELD_LABELS: Array<[FieldKey, string]> = [
  ['title', 'title'],
  ['slug', 'slug'],
  ['featuredImage', 'featured image(?: url)?'],
  ['imagePrompt', 'image prompt'],
  ['content', 'content|body'],
  ['excerpt', 'excerpt'],
  ['summary', 'summary(?: tl;?dr)?|tl;?dr'],
  ['keyTakeaways', 'key takeaways|takeaways'],
  ['categories', 'categor(?:ies|y)'],
  ['tags', 'tags'],
  ['postType', 'post type'],
  ['linkedin', 'linkedin(?: post)?'],
  ['twitter', '(?:twitter(?:\\/x)?|x)(?: post)?'],
];

const FIELD_MATCHERS: Array<[FieldKey, RegExp]> = FIELD_LABELS.map(([key, label]) => [
  key,
  // Numbering/heading/bullet prefix, optional bold, the label, then either end of line
  // (value on following lines) or an explicit separator with the value inline.
  new RegExp(`^(?:#{1,6}\\s+)?(?:\\d{1,2}[.)]\\s+)?(?:[-*]\\s+)?\\*{0,2}(?:${label})(?::?\\*{1,2})?\\s*(?:$|[—–:]\\s*(.*)$|-\\s+(.*)$)`, 'i'),
]);

const BLOG_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;

function matchFieldLabel(line: string): { key: FieldKey; inline: string } | undefined {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.length > 120) return undefined;
  for (const [key, matcher] of FIELD_MATCHERS) {
    const m = matcher.exec(trimmed);
    if (m) return { key, inline: (m[1] ?? m[2] ?? '').trim() };
  }
  return undefined;
}

function splitList(value: string, separators: RegExp): string[] {
  return value.split(separators)
    .map(entry => entry.replace(/^(?:[-*•]|\d{1,2}[.)])\s+/, '').replace(/^\*\*|\*\*$/g, '').trim())
    .filter(entry => entry !== '');
}

function parsePostType(value: string): PostType {
  const lower = value.toLowerCase();
  if (lower.includes('quick')) return 'quick';
  return POST_TYPES.find(type => lower.includes(type)) ?? 'article';
}

/** Parses the CMS package fields out of a blog note's markdown body. */
export function parseNoteBlogPackage(markdown: string, fallbackTitle: string): NoteBlogPackage {
  const body = markdown.replace(FRONTMATTER, '').trim();
  const sections = new Map<FieldKey, string[]>();
  let current: FieldKey | undefined;
  for (const line of body.split(/\r?\n/)) {
    const label = matchFieldLabel(line);
    if (label) {
      current = label.key;
      if (!sections.has(current)) sections.set(current, []);
      if (label.inline !== '') sections.get(current)!.push(label.inline);
      continue;
    }
    if (current !== undefined) sections.get(current)!.push(line);
  }
  const field = (key: FieldKey): string => (sections.get(key) ?? []).join('\n').trim();
  const inlineField = (key: FieldKey): string =>
    field(key).replace(/^\*\*|\*\*$/g, '').replace(/\s+/g, ' ').trim();

  const hasPackage = sections.has('content');
  const contentMarkdown = hasPackage ? field('content') : body;
  const title = inlineField('title') || fallbackTitle;
  const slugRaw = inlineField('slug').toLowerCase();
  const slug = BLOG_SLUG.test(slugRaw) ? slugRaw : undefined;

  const missing: string[] = [];
  if (!inlineField('title') && !fallbackTitle) missing.push('title');
  if (!hasPackage) missing.push('content (the whole note body will be published as the article)');
  for (const [key, name] of [['excerpt', 'excerpt'], ['summary', 'summary'], ['keyTakeaways', 'key takeaways'], ['categories', 'categories'], ['tags', 'tags']] as Array<[FieldKey, string]>) {
    if (field(key) === '') missing.push(name);
  }

  return {
    postType: parsePostType(field('postType')),
    title,
    ...(slug ? { slug } : {}),
    excerpt: inlineField('excerpt'),
    summary: field('summary').replace(/^\*\*|\*\*$/g, '').trim(),
    content: contentMarkdown === '' ? '' : marked.parse(contentMarkdown, { async: false }),
    keyTakeaways: splitList(field('keyTakeaways'), /\r?\n+/),
    categories: splitList(field('categories'), /[,\n]+/),
    tags: splitList(field('tags'), /[,\n]+/),
    missing,
  };
}

/** Confirms the note exists, is active and is a Blog draft; returns its parsed writing. */
async function requireBlogNote(db: Pool, noteId: string): Promise<{ content: string; title: string }> {
  const { rows } = await db.query<{ content: string }>(
    `SELECT content FROM notes WHERE id::text = $1 AND status = 'active'`, [noteId]);
  const row = rows[0];
  if (row === undefined) throw new NotFoundError('Note');
  const writing = parseWriting(row.content);
  if (writing.contentType !== 'blog') {
    throw new ValidationError('Only Blog draft notes can be published to the blog. Change the note\'s content type to Blog draft first.');
  }
  return { content: row.content, title: writing.title === 'Untitled' ? '' : writing.title };
}

export function assertBlogNote(db: Pool, noteId: string): Promise<unknown> {
  return requireBlogNote(db, noteId);
}

/** Loads a blog note and returns its parsed CMS draft fields. */
export async function loadNoteBlogPackage(db: Pool, noteId: string): Promise<NoteBlogPackage> {
  const note = await requireBlogNote(db, noteId);
  const markdown = await noteMarkdown(note.content, noteId);
  return parseNoteBlogPackage(markdown, note.title);
}
