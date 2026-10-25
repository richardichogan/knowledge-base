import { Marked, Renderer } from 'marked';
import { env } from '../config/env.js';

const escape = (text: string): string => text.replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const PRIMARY_HEADING_DEPTH = 1;
const SECONDARY_HEADING_DEPTH = 2;
const PRIMARY_HEADING_SIZE = 24;
const SECONDARY_HEADING_SIZE = 20;
const OTHER_HEADING_SIZE = 17;

function safeLink(href: string): string | null {
  try {
    const url = href.startsWith('/') && !href.startsWith('//') ? new URL(href, env.FRONTEND_BASE_URL) : new URL(href);
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

/** Only Markdown constructs become markup; authored HTML is always literal text. */
export function renderNoteEmail(title: string, markdown: string): string {
  const renderer = new Renderer();
  renderer.html = ({ text }): string => escape(text);
  renderer.link = function ({ href, tokens }): string {
    const label = this.parser.parseInline(tokens);
    const url = safeLink(href);
    return url ? `<a href="${escape(url)}" style="color:#0f62fe;text-decoration:underline">${label}</a>` : label;
  };
  renderer.image = ({ text, href }): string => {
    const url = safeLink(href);
    return url ? `<a href="${escape(url)}" style="color:#0f62fe">${escape(text || 'Image')}</a>` : escape(text || 'Image');
  };
  renderer.heading = function ({ depth, tokens }): string {
    const size = depth === PRIMARY_HEADING_DEPTH ? PRIMARY_HEADING_SIZE : depth === SECONDARY_HEADING_DEPTH ? SECONDARY_HEADING_SIZE : OTHER_HEADING_SIZE;
    return `<h${depth} style="font-size:${size}px;line-height:1.3;margin:24px 0 12px;font-weight:600;text-align:left">${this.parser.parseInline(tokens)}</h${depth}>`;
  };
  renderer.paragraph = function ({ tokens }): string {
    return `<p style="margin:0 0 16px;text-align:left">${this.parser.parseInline(tokens)}</p>`;
  };
  renderer.tablecell = function ({ header, tokens }): string {
    const tag = header ? 'th' : 'td';
    return `<${tag} style="border:1px solid #c6c6c6;padding:8px 12px;text-align:left;vertical-align:top">${this.parser.parseInline(tokens)}</${tag}>`;
  };
  renderer.table = function (token): string {
    return `<table style="border-collapse:collapse;width:100%;margin:16px 0"><thead>${this.tablerow({ text: token.header.map(cell => this.tablecell(cell)).join('') })}</thead><tbody>${token.rows.map(row => this.tablerow({ text: row.map(cell => this.tablecell(cell)).join('') })).join('')}</tbody></table>`;
  };
  const html = new Marked({ renderer, gfm: true }).parse(markdown, { async: false });
  return `<article aria-label="${escape(title)}" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.6;color:#262626;background:#ffffff;text-align:left;overflow-wrap:anywhere">${html}</article>`;
}
