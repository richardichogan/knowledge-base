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
          ? new URL(child, env.FRONTEND_BASE_URL).href
          : key === 'styles' && child !== null && typeof child === 'object' && !Array.isArray(child)
            ? Object.fromEntries(Object.entries(child).filter(([style]) => !['important', 'followUp', 'question', 'risk', 'issue'].includes(style)))
            : absoluteLinks(child),
      ]));
    }
    // The exporter crashes on props outside the default schema (e.g. script heading metadata), so drop them.
    const blockSchema = exporter.editor.schema.blockSchema as Record<string, { propSchema?: Record<string, unknown> }>;
    function knownProps(value: unknown): unknown {
      if (!Array.isArray(value)) return value;
      return value.map(block => {
        if (block === null || typeof block !== 'object') return block;
        const record = block as Record<string, unknown>;
        const propSchema = typeof record.type === 'string' ? blockSchema[record.type]?.propSchema : undefined;
        const props = propSchema && record.props && typeof record.props === 'object'
          ? Object.fromEntries(Object.entries(record.props).filter(([prop]) => prop in propSchema))
          : record.props;
        return { ...record, props, children: knownProps(record.children) };
      });
    }
    const markdown = await exporter.blocksToMarkdownLossy(knownProps(absoluteLinks(blocks)) as Parameters<typeof exporter.blocksToMarkdownLossy>[0]);
    return `---\nathena_note_id: ${noteId}\ntitle: ${JSON.stringify(writing.title)}\n---\n\n${markdown.trimEnd()}\n`;
  });
}

export function githubMarkdownBlocks(markdown: string): Promise<unknown[]> {
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
  return Promise.resolve(textToBlocks(body));
}
