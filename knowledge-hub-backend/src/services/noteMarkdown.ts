import { ServerBlockNoteEditor } from '@blocknote/server-util';
import { parseWriting } from './noteVersionService.js';
import { ValidationError } from '../types/errors.js';
import { textToBlocks } from '../ai/markdownToNoteBlocks.js';
import { getDb } from '../db/db.js';
import { resolveNoteLinks } from './noteLinks.js';
import { env } from '../config/env.js';

// The official exporter uses a temporary DOM; serialize calls so concurrent
// saves cannot interfere with its global window/document bindings.
let rendering: Promise<unknown> = Promise.resolve();
function serial<T>(run: () => Promise<T>): Promise<T> {
  const next = rendering.then(run, run);
  rendering = next.catch(() => {});
  return next;
}

export function noteMarkdown(content: string, noteId: string): Promise<string> {
  return serial(async () => {
    const writing = parseWriting(content);
    const exporter = ServerBlockNoteEditor.create();
    const blocks: unknown = await resolveNoteLinks(getDb(), content);
    if (!Array.isArray(blocks)) throw new ValidationError('Note body must be a block array');
    function absoluteLinks(value: unknown): unknown {
      if (Array.isArray(value)) return value.map(absoluteLinks);
      if (value === null || typeof value !== 'object') return value;
      const record = value as Record<string, unknown>;
      return Object.fromEntries(Object.entries(record).map(([key, child]) => [
        key, key === 'href' && typeof child === 'string' && /^\/(?:think|projects)\?/.test(child)
          ? new URL(child, env.FRONTEND_BASE_URL).href : absoluteLinks(child),
      ]));
    }
    // The exporter validates block types and props against the default schema.
    const markdown = await exporter.blocksToMarkdownLossy(absoluteLinks(blocks) as Parameters<typeof exporter.blocksToMarkdownLossy>[0]);
    return `---\nathena_note_id: ${noteId}\ntitle: ${JSON.stringify(writing.title)}\n---\n\n${markdown.trimEnd()}\n`;
  });
}

export function githubMarkdownBlocks(markdown: string): Promise<unknown[]> {
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
  return Promise.resolve(textToBlocks(body));
}
