import { textToBlocks, type NoteInline, type NoteMarkdownBlock } from './markdownToNoteBlocks.js';
import { ValidationError } from '../types/errors.js';
import { Parser } from 'htmlparser2';

const TITLE_LIMIT = 60;
const HTML_LIMIT = 4000;
const escape = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const inline = (parts: NoteInline[]): string => parts.map(part => part.type === 'link'
  ? `<a href="${escape(part.href)}">${inline(part.content)}</a>` : escape(part.text)).join('');

function render(blocks: NoteMarkdownBlock[]): string {
  let html = '';
  let list = false;
  for (const block of blocks) {
    const item = block.type === 'bulletListItem' || block.type === 'numberedListItem' || block.type === 'checkListItem';
    if (list && !item) { html += '</ul>'; list = false; }
    if (item && !list) { html += '<ul>'; list = true; }
    if (block.type === 'divider') continue;
    if (block.type === 'table') throw new ValidationError('Spotify show notes cannot contain tables.');
    const tag = item ? 'li' : block.type === 'heading' ? 'h3' : 'p';
    html += `<${tag}>${inline(block.content)}${block.children ? render(block.children) : ''}</${tag}>`;
  }
  return html + (list ? '</ul>' : '');
}

/** Preserve copyable HTML source, converting an incorrectly Markdown-formatted body rather than rendering it. */
export function spotifyShowNotesSource(content: string): string {
  const source = content.trim().replace(/^```(?:html|text)?\s*\n([\s\S]*?)\n```\s*$/i, '$1').trim();
  const newline = source.indexOf('\n');
  if (newline < 0) throw new ValidationError('Spotify show notes need a separate title and HTML body.');
  const title = source.slice(0, newline).replace(/^#{1,6}\s+/, '').replace(/^\*\*(.*?)\*\*$/, '$1').trim();
  if (!title || title.length >= TITLE_LIMIT || /[<>]/.test(title)) throw new ValidationError('The Spotify title must be plain text under 60 characters.');
  let body = source.slice(newline + 1).trim().replace(/^```html\s*\n([\s\S]*?)\n```\s*$/i, '$1').trim();
  if (!/<(?:p|h3|ul|li|a)(?:\s|>)/i.test(body)) body = render(textToBlocks(body));
  if (!body || body.length >= HTML_LIMIT) throw new ValidationError('The Spotify HTML body must be under 4,000 characters.');
  const invalid = (): never => { throw new ValidationError('Spotify HTML may use only p, h3, ul, li and a tags, with HTTP(S) links.'); };
  let openTags = 0;
  const parser = new Parser({
    onopentag: (tag, attributes): void => {
      if (!['p', 'h3', 'ul', 'li', 'a'].includes(tag)) invalid();
      openTags++;
      if (tag !== 'a') { if (Object.keys(attributes).length) invalid(); return; }
      if (Object.keys(attributes).length !== 1 || typeof attributes['href'] !== 'string') invalid();
      let url: URL;
      try { url = new URL(attributes['href']!); } catch { return invalid(); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) invalid();
    },
    onclosetag: (): void => { openTags--; },
    ontext: (text): void => { if (!openTags && text.trim()) throw new ValidationError('The Spotify body contains text outside its HTML paragraphs. Convert the complete body to HTML.'); },
    oncomment: invalid,
    onprocessinginstruction: invalid,
  });
  parser.write(body);
  parser.end();
  return `${title}\n${body}`;
}

export function validateShowNotesReferences(spotify: string, youtube: string, metadata: string): void {
  const htmlLinks = new Set<string>();
  let heading = false;
  let headingText = '';
  let section = '';
  const parser = new Parser({
    onopentag: (tag, attributes): void => {
      if (tag === 'h3') { heading = true; headingText = ''; }
      if (tag === 'a' && section === 'links' && attributes['href']) htmlLinks.add(new URL(attributes['href']).href);
    },
    ontext: (text): void => { if (heading) headingText += text; },
    onclosetag: (tag): void => { if (tag === 'h3') { heading = false; section = headingText.trim().toLowerCase(); } },
  });
  parser.write(spotifyShowNotesSource(spotify).split('\n').slice(1).join('\n'));
  parser.end();
  const lines = youtube.split(/\r?\n/);
  const linksStart = lines.findIndex(line => /^Links:\s*$/i.test(line));
  const following = linksStart < 0 ? [] : lines.slice(linksStart + 1);
  const linksEnd = following.findIndex(line => /^(?:Socials|Music):\s*$/i.test(line));
  const linksGroup = (linksEnd < 0 ? following : following.slice(0, linksEnd)).join('\n');
  const plainLinks = new Set<string>();
  for (const link of linksGroup.match(/https?:\/\/[^\s<>]+/g) ?? []) {
    try { plainLinks.add(new URL(link).href); }
    catch { throw new ValidationError('The YouTube Links section contains an invalid reference URL.'); }
  }
  if ([...plainLinks].some(url => !htmlLinks.has(url)) || [...htmlLinks].some(url => !plainLinks.has(url))) {
    const missing = [...plainLinks].filter(url => !htmlLinks.has(url));
    const extra = [...htmlLinks].filter(url => !plainLinks.has(url));
    throw new ValidationError('The YouTube and Spotify reference links do not match. '
      + `Missing from Spotify: ${missing.join(', ') || 'none'}. Missing from YouTube: ${extra.join(', ') || 'none'}. `
      + 'Repair both Links sections before saving.');
  }
  if (!htmlLinks.size && !/\b(?:unverified|unverifiable|missing|unavailable)\s+(?:reference|source|resource|link)|\b(?:reference|source|resource|link)s?\s+(?:limitations|unavailable|could not be verified)|no\s+(?:reference\s+)?(?:links|urls)\s+(?:could be|were)\s+verified/i.test(metadata)) {
    throw new ValidationError('Reference links are missing. Add verified episode references or explicitly document unavailable references in Titles and metadata.');
  }
}
