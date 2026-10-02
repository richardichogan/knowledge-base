/**
 * Minimal, dependency-free markdown → HTML renderer.
 * Supports headings, bold/italic emphasis, inline code, links, fenced code
 * blocks, blockquotes, horizontal rules, and bullet lists — enough for
 * GitHub-flavoured project docs and AI chat replies.
 *
 * Shared by DocumentsPage (Library viewer) and AIChatPage (chat bubbles) so
 * both surfaces render markdown identically.
 */

import { sanitizeHtml } from './sanitizeHtml';
import { installTableExport } from './tableExport';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inlineMarkdown(text: string): string {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

function isTableRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line);
}

/** "| a | b \\| c |" → ['a', 'b | c']. */
function splitTableRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return inner.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

/** A table with a "Download as Excel" button (handled page-wide by tableExport.ts). */
function renderTable(rows: string[][]): string {
  const [head, ...body] = rows;
  const cells = (r: string[], tag: 'th' | 'td'): string => r.map((c) => `<${tag}>${inlineMarkdown(c)}</${tag}>`).join('');
  return '<div class="kh-table-block">'
    + '<button type="button" class="kh-table-xlsx-btn" data-xlsx-table>Download as Excel</button>'
    + `<div class="kh-table-scroll"><table><thead><tr>${cells(head ?? [], 'th')}</tr></thead>`
    + `<tbody>${body.map((r) => `<tr>${cells(r, 'td')}</tr>`).join('')}</tbody></table></div></div>`;
}

export function renderMarkdown(md: string): string {
  installTableExport();
  const lines = md.split('\n');
  const html: string[] = [];
  let inCode = false;
  // Tracks which list type (if any) is currently open, so switching between
  // a bullet list and a numbered list (or ending either) closes the right tag.
  let listType: 'ul' | 'ol' | null = null;

  const closeList = () => {
    if (listType) { html.push(`</${listType}>`); listType = null; }
  };

  // Fences are often indented under a list item ("1. Clone:\n   ```bash");
  // remember that indent so it can be stripped from the code lines.
  let fenceIndent = 0;
  // Numbered lists interrupted by a code block or blank line would otherwise
  // restart at 1 — docs that write "1." for every step relied on this.
  let olCount = 0;
  let olResume = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^(\s*)```(.*)$/.exec(line);
    if (fence && (!inCode || fence[1]!.length <= fenceIndent + 3)) {
      if (!inCode && listType === 'ol') olResume = olCount + 1;
      closeList();
      if (inCode) { html.push('</code></pre></div>'); inCode = false; }
      else {
        fenceIndent = fence[1]!.length;
        html.push(`<div class="kh-code-block"><button type="button" class="kh-code-copy-btn" data-copy-code>Copy</button><pre><code class="language-${escapeHtml((fence[2] ?? '').trim())}">`);
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      const stripped = line.slice(Math.min(fenceIndent, line.length - line.trimStart().length));
      html.push(escapeHtml(stripped));
      continue;
    }
    // A pipe table: header row, separator row (|---|), then rows.
    if (isTableRow(line) && TABLE_SEPARATOR.test(lines[i + 1] ?? '')) {
      closeList();
      olResume = 0;
      const rows: string[][] = [splitTableRow(line)];
      let j = i + 2;
      while (j < lines.length && isTableRow(lines[j]!)) { rows.push(splitTableRow(lines[j]!)); j += 1; }
      html.push(renderTable(rows));
      i = j - 1;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      closeList();
      html.push('<hr />'); continue;
    }
    const hm = line.match(/^(#{1,6})\s+(.+)/);
    if (hm) {
      closeList();
      olResume = 0;
      html.push(`<h${hm[1]!.length}>${inlineMarkdown(hm[2] ?? '')}</h${hm[1]!.length}>`); continue;
    }
    if (line.startsWith('> ')) {
      closeList();
      html.push(`<blockquote>${inlineMarkdown(line.slice(2))}</blockquote>`); continue;
    }
    const oli = line.match(/^\s*(\d+)[.)]\s+(.+)/);
    if (oli) {
      // Honour the number the markdown actually supplies, so a list that
      // resumes at 4 renders as 4 rather than silently restarting at 1.
      if (listType !== 'ol') {
        closeList();
        let start = Number(oli[1] ?? '1');
        // Lazy "1." numbering resuming after an interruption continues the count.
        if (start === 1 && olResume > 0) start = olResume;
        olResume = 0;
        olCount = start - 1;
        html.push(start === 1 ? '<ol>' : `<ol start="${start.toString()}">`);
        listType = 'ol';
      }
      olCount += 1;
      html.push(`<li>${inlineMarkdown(oli[2] ?? '')}</li>`); continue;
    }
    const li = line.match(/^\s*[-*+]\s+(.+)/);
    if (li) {
      if (listType !== 'ul') { closeList(); html.push('<ul>'); listType = 'ul'; }
      html.push(`<li>${inlineMarkdown(li[1] ?? '')}</li>`); continue;
    }
    if (line.trim() === '') {
      if (listType === 'ol') olResume = olCount + 1;
      closeList();
      continue;
    }
    closeList();
    // Indented text continues the current list item; anything else ends the numbering run.
    if (!/^\s/.test(line)) olResume = 0;
    html.push(`<p>${inlineMarkdown(line)}</p>`);
  }

  closeList();
  if (inCode) html.push('</code></pre></div>');
  return sanitizeHtml(html.join('\n'));
}
